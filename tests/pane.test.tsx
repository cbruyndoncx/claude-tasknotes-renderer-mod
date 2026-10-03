import { expect, test } from 'claude-code/testing'

import { FILES, ROOT, realOf } from './fixtures'

// `claude plugin test` gives the plugin no real filesystem: the test's hooks serve a vault
// (TaskNotes settings, task notes, three .base files) rooted at C:\vault.

type Host = { content?: Record<string, string>; cwd?: string; reads?: string[] }

function serveVault(on: Parameters<Parameters<typeof test>[1]>[1], host: Host = {}) {
  const content = host.content ?? { ...FILES }
  const mtimes = new Map<string, number>()
  const relAt = (path: string) => {
    const norm = path.replace(/\//g, '\\')
    return Object.keys(content).find(rel => norm === realOf(rel) || norm === rel.split('/').join('\\'))
  }
  const dirs = () => {
    const out = new Set<string>()
    for (const rel of Object.keys(content)) {
      const parts = rel.split('/')
      for (let k = 1; k < parts.length; k++) out.add(realOf(parts.slice(0, k).join('/')))
    }
    return out
  }
  on('fs.stat', ($, e) => {
    const rel = relAt(e.path)
    if (rel) return { value: { kind: 'file', size: content[rel]?.length ?? 0, mtimeMs: mtimes.get(rel) ?? 1000, isLink: false, realPath: realOf(rel) } }
    if (dirs().has(e.path)) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }
    return { deny: `ENOENT ${e.path}` }
  })
  on('fs.exists', ($, e) => ({ value: e.path === `${ROOT}\\.obsidian` || !!relAt(e.path) || dirs().has(e.path) }))
  on('fs.read', ($, e) => {
    const rel = relAt(e.path)
    host.reads?.push(e.path)
    return rel ? { value: content[rel] ?? '' } : { deny: `ENOENT ${e.path}` }
  })
  on('fs.list', ($, e) => {
    const dir = String(e.path ?? '')
    const entries = new Map<string, { name: string; kind: 'file' | 'dir'; size: number; mtimeMs: number; isLink: boolean }>()
    for (const rel of Object.keys(content)) {
      const real = realOf(rel)
      if (!real.startsWith(`${dir}\\`)) continue
      const rest = real.slice(dir.length + 1)
      const name = rest.split('\\')[0] ?? ''
      const isDir = rest.includes('\\')
      entries.set(name, { name, kind: isDir ? 'dir' : 'file', size: isDir ? 0 : (content[rel]?.length ?? 0), mtimeMs: isDir ? 0 : (mtimes.get(rel) ?? 1000), isLink: false })
    }
    return { value: [...entries.values()] }
  })
  on('session.cwd', () => ({ value: host.cwd ?? ROOT }))
  on('session.root', () => ({ value: host.cwd ?? ROOT }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  return {
    content,
    touch(rel: string, text: string) {
      content[rel] = text
      mtimes.set(rel, (mtimes.get(rel) ?? 1000) + 1000)
    },
  }
}

const mount = ($: Parameters<Parameters<typeof test>[1]>[0], surface: 'desktop' | 'terminal' = 'desktop') =>
  $.ui.mount({
    plugin: 'tasknotes-preview',
    surface,
    component: 'Pane',
    requestId: 'tasks',
    props: { title: 'Tasks', isFocused: false, bodyColumns: 120, placement: 'dock' },
  })

test('/taskboard kanban opens the TaskNotes kanban base as a board with status columns', async ($, on) => {
  serveVault(on)
  const ran = await $.command.run({ command: 'taskboard', args: 'kanban' })
  expect(ran.text).toContain('Showing TaskNotes/Views/kanban.base in the Tasks pane.')
  expect(ran.text).toContain('Kanban Board (tasknotesKanban): 6 tasks; None 0, Backlog 1, Next 2, In progress 1, Awaiting Input 1, Done 1, Cancelled 0')
  const ui = await mount($)
  expect(await ui.find({ type: 'Text', text: 'Awaiting Input' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Launch' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '⛔ blocked by 2' })).toBeDefined()
  expect((await ui.find({ key: 'layout-board' }))?.props.variant).toBe('primary')
  for (const key of ['layout-list', 'layout-agenda', 'layout-graph', 'refresh', 'open-base', 'open:TaskNotes/Tasks/Launch.md']) {
    expect(await ui.find({ key })).toBeDefined()
  }
  expect(await ui.find({ key: 'view' })).toBeUndefined() // one view: no view picker
  await ui.unmount()
})

test('the view picker switches views; each draws its own way', async ($, on) => {
  serveVault(on)
  const ran = await $.command.run({ command: 'taskboard', args: 'TaskNotes/Views/tasks.base' })
  expect(ran.text).toContain('Not Blocked (tasknotesTaskList): 2 tasks')
  const ui = await mount($)
  expect((await ui.find({ key: 'layout-list' }))?.props.variant).toBe('primary')
  expect(await ui.find({ type: 'Text', text: 'Build API' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Launch' })).toBeUndefined() // blocked
  await ui.select({ key: 'view', value: '1' }) // This Week
  expect(await ui.find({ type: 'Text', text: 'Write docs' })).toBeDefined()
  await ui.select({ key: 'view', value: '3' }) // Odd: an unsupported filter is reported
  expect((await ui.find({ type: 'Text', text: /^Note: skipped/ }))?.text).toContain('file.backlinks is not supported')
  await ui.unmount()
})

test('a view by name and a layout flag on the command; unknown views are listed', async ($, on) => {
  serveVault(on)
  const ran = await $.command.run({ command: 'taskboard', args: 'tasks This Week --board' })
  expect(ran.text).toContain('This Week (tasknotesTaskList): 3 tasks;')
  const ui = await mount($)
  expect((await ui.find({ key: 'layout-board' }))?.props.variant).toBe('primary')
  await ui.unmount()
  const bad = await $.command.run({ command: 'taskboard', args: 'tasks Someday' })
  expect(bad.text).toContain('no view "Someday"; there are: 1. Not Blocked, 2. This Week, 3. TableView, 4. Odd')
  const missing = await $.command.run({ command: 'taskboard', args: 'nowhere.base' })
  expect(missing.text).toContain('nowhere.base not found')
})

test('agenda: overdue on top, then today and the coming days', async ($, on) => {
  serveVault(on)
  await $.command.run({ command: 'taskboard', args: 'agenda' })
  const ui = await mount($)
  expect((await ui.find({ key: 'layout-agenda' }))?.props.variant).toBe('primary')
  expect(await ui.find({ type: 'Text', text: 'Overdue · 1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Today · / })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Pay invoice' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Daily review' })).toBeDefined()
  await ui.unmount()
})

test('graph: blockedBy arrows as SVG with orientation and zoom controls', async ($, on) => {
  serveVault(on)
  const ran = await $.tool.call({ tool: 'mcp__tasknotes-preview__open', base: 'kanban', layout: 'graph' })
  expect(String(ran.result)).toContain('4 dependencies among 4 tasks; critical path 14 days')
  const ui = await mount($)
  const svg = async () => String((await ui.find({ type: 'Svg' }))?.props.source ?? '')
  expect(await svg()).toContain('Write docs')
  expect((await ui.find({ type: 'Text', text: /critical path 14 days/ }))?.text).toContain('2 without dependencies not drawn')
  const size = async () => /width="([\d.]+)" height="([\d.]+)"/.exec(await svg())!.slice(1).map(Number)
  const [w, h] = await size()
  expect(w!).toBeGreaterThan(h!)
  await ui.press({ key: 'orientation' })
  const [w2, h2] = await size()
  expect(h2!).toBeGreaterThan(w2!)
  await ui.press({ key: 'zoom-in' })
  expect(await ui.find({ key: 'pan-right' })).toBeDefined()
  await ui.unmount()
})

test('layout buttons redraw the same rows; long columns fold behind "Show all"', async ($, on) => {
  const host = serveVault(on)
  for (let k = 0; k < 14; k++) {
    host.content[`TaskNotes/Tasks/Chore ${k}.md`] = `---\ntitle: Chore ${k}\ntype: task\nstatus: open\n---\n`
  }
  await $.command.run({ command: 'taskboard', args: 'kanban' })
  const ui = await mount($)
  expect(await ui.find({ type: 'Text', text: 'Chore 13' })).toBeUndefined() // 15 in Backlog, 12 shown
  await ui.press({ key: 'more:open' })
  expect(await ui.find({ type: 'Text', text: 'Chore 13' })).toBeDefined()
  await ui.press({ key: 'layout-list' })
  expect((await ui.find({ key: 'layout-list' }))?.props.variant).toBe('primary')
  expect(await ui.find({ type: 'Text', text: 'Backlog' })).toBeDefined() // the board's grouping carries over
  await ui.unmount()
})

test('an agent Edit of a task note redraws the pane; unchanged notes are not read again', async ($, on) => {
  const reads: string[] = []
  const host = serveVault(on, { reads })
  on('tool.call', { tool: 'Edit' }, () => ({ result: { ok: true } }))
  await $.command.run({ command: 'taskboard', args: 'kanban' })
  const ui = await mount($)
  reads.length = 0
  host.touch('TaskNotes/Tasks/Write docs.md', (host.content['TaskNotes/Tasks/Write docs.md'] ?? '').replace('status: open', 'status: in-progress'))
  await $.tool.call({ tool: 'Edit', file_path: realOf('TaskNotes/Tasks/Write docs.md'), old_string: 'open', new_string: 'in-progress' })
  expect(await ui.find({ type: 'Text', text: 'Backlog' })).toBeDefined()
  const backlog = await ui.findAll({ type: 'Text', text: 'No tasks' })
  expect(backlog.length).toBe(3) // None, Backlog (now empty) and Cancelled
  expect(reads.filter(r => r.endsWith('.md'))).toEqual([realOf('TaskNotes/Tasks/Write docs.md')])
  await ui.unmount()
})

test('outside a vault an alias explains itself; the terminal gets a text account', async ($, on) => {
  serveVault(on, { cwd: 'D:\\elsewhere' })
  const ran = await $.command.run({ command: 'taskboard', args: 'kanban' })
  expect(ran.text).toContain('this session is not inside an Obsidian vault')
  await $.command.run({ command: 'taskboard', args: `${ROOT}\\TaskNotes\\Views\\kanban.base` })
  const term = await mount($, 'terminal')
  expect(await term.find({ type: 'Text', text: /Kanban Board \(tasknotesKanban\): 6 tasks/ })).toBeDefined()
  await term.unmount()
})
