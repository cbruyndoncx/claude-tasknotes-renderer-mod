import { expect, test } from 'claude-code/testing'

import { FILES, ROOT, realOf } from './fixtures'

// A vault the size of a real one (1,600 notes with Done When sections and blockedBy
// chains), timed inside the plugin engine. Every hook has a 10-second budget of its own
// time; a redraw (a resize, Fit, a layout press) that rebuilt everything used most of it,
// and an overrun got the whole plugin dropped. The limits here are generous on purpose.

const BODY = `## Context\n${'Some context text for the task. '.repeat(40)}\n\n## Ready When\n\n- [x] R1: outcome\n  EVIDENCE: ok\n- [ ] R2: inputs\n\n## Done When\n\n- [x] AC1: one\n  CHECK: test -f x\n  EXPECT: OK\n- [ ] AC2: two\n- [ ] AC3: three\n\n## Notes\n${'More notes here. '.repeat(60)}\n`

function bigVault(): Record<string, string> {
  const out: Record<string, string> = { ...FILES }
  const statuses = ['open', 'next', 'in-progress', 'awaiting-input', 'done', 'done', 'done']
  for (let k = 0; k < 1600; k++) {
    const folder = k < 400 ? 'TaskNotes/Tasks' : 'TaskNotes/Archive'
    const status = k < 400 ? statuses[k % statuses.length] : 'done'
    const blocked = k % 7 === 3 && k > 10 ? `blockedBy:\n  - "[[Task ${k - 3}]]"\n` : ''
    out[`${folder}/Task ${k}.md`] = `---\ntitle: Task ${k}\ntype: task\nstatus: ${status}\npriority: ${['low', 'normal', 'high'][k % 3]}\nsize: ${['S', 'M', 'L'][k % 3]}\ndateCreated: 2026-09-01T10:00:00.000+02:00\ndateModified: 2026-09-20 10:00:00+02:00\ntags:\n  - task\nassignee: ["agent"]\nprojects:\n  - '[[Project ${k % 12}]]'\n${blocked}cluster: C${k % 5}\n---\n${BODY}`
  }
  return out
}

function serve(on: Parameters<Parameters<typeof test>[1]>[1], content: Record<string, string>) {
  const relAt = (path: string) => {
    const norm = path.replace(/\//g, '\\')
    return Object.keys(content).find(rel => norm === realOf(rel) || norm === rel.split('/').join('\\'))
  }
  const byReal = new Map(Object.keys(content).map(rel => [realOf(rel), rel]))
  on('fs.stat', ($, e) => {
    const rel = byReal.get(e.path) ?? relAt(e.path)
    return rel ? { value: { kind: 'file', size: content[rel]?.length ?? 0, mtimeMs: 1000, isLink: false, realPath: realOf(rel) } } : { deny: 'ENOENT' }
  })
  on('fs.exists', ($, e) => ({ value: e.path === `${ROOT}\\.obsidian` || byReal.has(e.path) }))
  on('fs.read', ($, e) => {
    const rel = byReal.get(e.path) ?? relAt(e.path)
    return rel ? { value: content[rel] ?? '' } : { deny: 'ENOENT' }
  })
  on('fs.list', ($, e) => {
    const dir = String(e.path ?? '')
    const entries = new Map<string, unknown>()
    for (const real of byReal.keys()) {
      if (!real.startsWith(`${dir}\\`)) continue
      const rest = real.slice(dir.length + 1)
      const name = rest.split('\\')[0] ?? ''
      const isDir = rest.includes('\\')
      entries.set(name, { name, kind: isDir ? 'dir' : 'file', size: 100, mtimeMs: 1000, isLink: false })
    }
    return { value: [...entries.values()] }
  })
  on('session.cwd', () => ({ value: ROOT }))
  on('session.root', () => ({ value: ROOT }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
}

test('a 1,600-note vault opens well inside the budget and redraws cheaply', { timeoutMs: 120000 }, async ($, on) => {
  serve(on, bigVault())
  let t = Date.now()
  const ran = await $.command.run({ command: 'taskboard', args: 'kanban --graph' })
  const first = Date.now() - t
  console.log(`command (first load + evaluate): ${first} ms — ${String(ran.text).slice(0, 160)}`)
  // Wall-clock with the other test files running beside it (about 2 s alone); the guard
  // that matters is the redraws below, which run on every press and resize.
  expect(first).toBeLessThan(15000)
  t = Date.now()
  const ui = await $.ui.mount({ plugin: 'tasknotes-preview', surface: 'desktop', component: 'Pane', requestId: 'tasks', props: { title: 'Tasks', isFocused: false, bodyColumns: 120, placement: 'dock' } })
  console.log(`mount (graph): ${Date.now() - t} ms`)
  for (const key of ['zoom-fit', 'layout-board', 'layout-list', 'layout-agenda', 'layout-graph']) {
    t = Date.now()
    await ui.press({ key })
    const took = Date.now() - t
    console.log(`press ${key}: ${took} ms`)
    expect(took).toBeLessThan(2000)
  }
  expect(await ui.find({ type: 'Svg' })).toBeDefined()
  await ui.unmount()
})
