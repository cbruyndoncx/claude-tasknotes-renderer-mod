import { memberOf, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Layout, TasksTarget } from '../types'
import { buildAgenda, dayLabel } from './agenda'
import type { AgendaItem } from './agenda'
import { parseBase } from './bases'
import type { BaseConfig } from './bases'
import {
  SVG_LIMIT,
  asOrientation,
  cleanArg,
  errorText,
  isInside,
  joinPath,
  launchers,
  obsidianUri,
  panStep,
  parentOf,
  samePath,
  sepOf,
  stepZoom,
  targetIn,
  zoomLabel,
  zoomView,
} from './common'
import type { Target } from './common'
import { FileV, linkKey, toDate } from './expr'
import { buildGraph, graphSvg } from './graph'
import { buildModel, columnsOf, facets, narrow } from './model'
import type { Card, Column, Facet, Filters, Model } from './model'
import { VIEW_ALIASES, fieldKey, parseSettings, toTask } from './tasknotes'
import type { Task, TaskNotesSettings } from './tasknotes'
import { splitFrontmatter } from './yaml'

const TARGET = { plugin: 'tasknotes-preview', key: 'target' } as const
const PANE = 'tasks'
const LAYOUTS: Layout[] = ['board', 'list', 'agenda', 'graph']
const LAYOUT_LABEL: Record<Layout, string> = { board: 'Board', list: 'List', agenda: 'Agenda', graph: 'Graph' }
/** Cards per column (or rows per section) before a "show all" button. */
const CAP = 12

// ── the vault ────────────────────────────────────────────────────────────

type Entry = { mtime: number; file: FileV; body: string }

/**
 * Parsed notes by absolute path and modification time. The first draw reads every task
 * note; after that only changed files are read again. A module variable: a reload costs
 * one full read.
 */
const notes = new Map<string, Entry>()

type Vault = {
  settings: TaskNotesSettings
  /** Every note in the TaskNotes tasks and archive folders: what base filters run over. */
  files: FileV[]
  /** The task notes among them (TaskNotes' own identification), for resolving links. */
  tasks: Task[]
  taskOf: (file: FileV) => Task
  resolve: (target: string) => FileV | undefined
}

async function findVaultRoot($: EngineInterface, from: string): Promise<string | undefined> {
  for (let dir: string | undefined = from; dir; dir = parentOf(dir)) {
    if (await $.fs.exists(`${dir}${sepOf(dir)}.obsidian`).catch(() => false)) return dir
  }
  return undefined
}

async function listNotes($: EngineInterface, dir: string, out: { real: string; mtime: number; size: number }[], depth = 0): Promise<void> {
  if (depth > 8) return
  const entries = await $.fs.list(dir).catch(() => [])
  const sep = sepOf(dir)
  const subdirs: string[] = []
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const real = `${dir}${sep}${e.name}`
    if (e.kind === 'dir') subdirs.push(real)
    else if (e.kind === 'file' && e.name.toLowerCase().endsWith('.md')) out.push({ real, mtime: e.mtimeMs, size: e.size })
  }
  for (const sub of subdirs) await listNotes($, sub, out, depth + 1)
}

function tagsOf(data: Record<string, unknown>): string[] {
  const raw = data.tags ?? data.tag
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,]+/) : []
  return list.map(t => String(t).trim().replace(/^#/, '')).filter(Boolean)
}

function linksOf(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/\[\[([^\]|#]+)/g)) out.add((m[1] ?? '').trim())
  return [...out]
}

async function loadVault($: EngineInterface, root: string): Promise<Vault> {
  const settingsText = await $.fs.read(joinPath(root, '.obsidian/plugins/tasknotes/data.json')).catch(() => undefined)
  const settings = parseSettings(settingsText)
  const listed: { real: string; mtime: number; size: number }[] = []
  for (const folder of [settings.tasksFolder, settings.archiveFolder]) {
    const dir = joinPath(root, folder)
    if (!listed.some(l => isInside(l.real, dir))) await listNotes($, dir, listed)
  }
  const stale = listed.filter(l => notes.get(l.real)?.mtime !== l.mtime)
  for (let k = 0; k < stale.length; k += 32) {
    await Promise.all(stale.slice(k, k + 32).map(async l => {
      const text = await $.fs.read(l.real).catch(() => '')
      const { data, body } = splitFrontmatter(text)
      const rel = l.real.slice(root.length + 1).split(sepOf(l.real)).join('/')
      const created = toDate(data[fieldKey(settings, 'dateCreated')])?.ms ?? l.mtime
      const file = new FileV(rel, data, l.mtime, created, l.size, tagsOf(data), linksOf(text))
      notes.set(l.real, { mtime: l.mtime, file, body })
    }))
  }
  const entries = listed.map(l => notes.get(l.real)).filter((e): e is Entry => !!e)
  const byFile = new Map(entries.map(e => [e.file, e]))
  const taskCache = new Map<FileV, Task>()
  const taskOf = (file: FileV) => {
    let t = taskCache.get(file)
    if (!t) {
      t = toTask(file, byFile.get(file)?.body ?? '', settings)
      taskCache.set(file, t)
    }
    return t
  }
  const files = entries.map(e => e.file)
  const byKey = new Map<string, FileV>()
  for (const f of files) {
    byKey.set(f.path.replace(/\.md$/i, '').toLowerCase(), f)
    if (!byKey.has(linkKey(f))) byKey.set(linkKey(f), f)
  }
  const resolve = (target: string) => byKey.get(target.replace(/\\/g, '/').replace(/\.md$/i, '').toLowerCase()) ?? byKey.get(linkKey(target))
  return { settings, files, tasks: files.map(taskOf), taskOf, resolve }
}

// ── targets ──────────────────────────────────────────────────────────────

type Parsed = { what: string; view?: string; layout?: Layout; projects?: string[]; contexts?: string[] }

/** A comma-separated filter value: `Platform, Website` → ['Platform', 'Website']. */
function names(value: unknown): string[] {
  return String(value ?? '').split(',').map(s => cleanArg(s).replace(/^\[\[|\]\]$/g, '')).filter(Boolean)
}

/** `/taskboard [base|alias] [view] [--board|--list|--agenda|--graph] [--project=A,B] [--context=X]`. */
function parseArgs(args: string): Parsed {
  let rest = args.trim()
  let layout: Layout | undefined
  const picked: { projects: string[]; contexts: string[] } = { projects: [], contexts: [] }
  for (const m of [...rest.matchAll(/\s*--(project|context)=("[^"]*"|\S+)/gi)]) {
    picked[(m[1] ?? '').toLowerCase() === 'project' ? 'projects' : 'contexts'].push(...names(m[2]))
  }
  rest = rest.replace(/\s*--(project|context)=("[^"]*"|\S+)/gi, '').trim()
  const flag = /\s*--(board|list|agenda|graph)\b/i.exec(rest)
  if (flag) {
    layout = (flag[1] ?? '').toLowerCase() as Layout
    rest = (rest.slice(0, flag.index) + rest.slice(flag.index + flag[0].length)).trim()
  }
  let what = ''
  const quoted = /^"([^"]+)"\s*(.*)$/.exec(rest)
  if (quoted) {
    what = quoted[1] ?? ''
    rest = quoted[2] ?? ''
  } else {
    const at = rest.toLowerCase().indexOf('.base')
    if (at >= 0) {
      what = rest.slice(0, at + 5)
      rest = rest.slice(at + 5)
    } else {
      const word = /^(\S+)\s*(.*)$/.exec(rest)
      if (word && VIEW_ALIASES[(word[1] ?? '').toLowerCase()]) {
        what = word[1] ?? ''
        rest = word[2] ?? ''
      }
    }
  }
  const parsed: Parsed = { what: cleanArg(what) || 'tasks' }
  if (rest.trim()) parsed.view = cleanArg(rest)
  if (layout) parsed.layout = layout
  if (picked.projects.length) parsed.projects = picked.projects
  if (picked.contexts.length) parsed.contexts = picked.contexts
  return parsed
}

type Located = Target & { root: string }

async function locate($: EngineInterface, what: string): Promise<Located | { error: string }> {
  const alias = VIEW_ALIASES[what.toLowerCase()]
  if (alias) {
    const root = (await findVaultRoot($, await $.session.cwd())) ?? (await findVaultRoot($, await $.session.root()))
    if (!root) return { error: `"${what}" names a TaskNotes view, but this session is not inside an Obsidian vault; give a .base path` }
    const settings = parseSettings(await $.fs.read(joinPath(root, '.obsidian/plugins/tasknotes/data.json')).catch(() => undefined))
    const rel = settings.viewFiles[alias]
    if (!rel) return { error: `TaskNotes has no file for "${what}"` }
    const real = joinPath(root, rel)
    if (!(await $.fs.exists(real).catch(() => false))) return { error: `TaskNotes opens ${rel} for "${what}", but it does not exist` }
    return { ...targetIn(root, real), root }
  }
  if (!what.toLowerCase().endsWith('.base')) return { error: `${what} is not a .base file or a view name (${Object.keys(VIEW_ALIASES).join(', ')})` }
  const stat = await $.fs.stat(what, { resolve: true }).catch(() => undefined)
  let real = stat?.kind === 'file' ? stat.realPath : undefined
  if (!real) {
    // A vault-relative path from a session started elsewhere in the vault.
    const root = await findVaultRoot($, await $.session.cwd())
    const candidate = root ? joinPath(root, what) : undefined
    if (candidate && (await $.fs.exists(candidate).catch(() => false))) real = candidate
  }
  if (!real) return { error: `${what} not found` }
  const root = await findVaultRoot($, parentOf(real) ?? real)
  if (!root) return { error: `${what} is not inside an Obsidian vault (no .obsidian folder above it)` }
  return { ...targetIn(root, real), root }
}

function pickView(config: BaseConfig, wanted?: string): number | { error: string } {
  if (!wanted) return 0
  const n = Number(wanted)
  if (Number.isInteger(n) && n >= 1 && n <= config.views.length) return n - 1
  const i = config.views.findIndex(v => v.name.toLowerCase() === wanted.toLowerCase())
  if (i >= 0) return i
  return { error: `no view "${wanted}"; there are: ${config.views.map((v, k) => `${k + 1}. ${v.name}`).join(', ')}` }
}

async function openInObsidian($: EngineInterface, target: Target): Promise<string> {
  const uri = obsidianUri(target)
  if (!uri) throw new Error('the file is not inside an Obsidian vault')
  let last = 'no launcher available'
  for (const argv of launchers(uri)) {
    try {
      const run = await $.process.run(argv, { timeoutMs: 15000 })
      if (run.exitCode === 0) return argv[0] ?? 'launcher'
      last = `${argv[0]} exited ${run.exitCode}: ${run.stderr.trim().slice(0, 200)}`
    } catch (err) {
      last = `${argv[0]}: ${errorText(err)}`
    }
  }
  throw new Error(last)
}

// ── evaluation ───────────────────────────────────────────────────────────

type Drawn = {
  config: BaseConfig
  vault: Vault
  /** The whole view, as the base defines it. */
  all: Model
  /** The view narrowed by the pills: what the pane draws. */
  model: Model
  layout: Layout
  now: number
}

function filtersOf(t: TasksTarget): Filters {
  return { projects: t.projects ?? [], contexts: t.contexts ?? [] }
}

/**
 * The last evaluations, by base, view, the notes' modification times and the minute. A
 * layout, expand or zoom press redraws the pane; it should not run every filter again.
 */
const evaluations = new Map<string, Omit<Drawn, 'layout' | 'model'>>()

async function evaluate($: EngineInterface, t: TasksTarget): Promise<Drawn> {
  const [vault, source] = await Promise.all([loadVault($, t.root), $.fs.read(t.real)])
  const now = Date.now()
  const signature = vault.files.reduce((h, f) => (Math.imul(h, 31) + f.mtime + f.path.length) | 0, vault.files.length)
  const key = `${t.real}|${t.view}|${source.length}|${Array.from(source).reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7)}|${signature}|${Math.floor(now / 60000)}`
  const cached = evaluations.get(key)
  if (cached) return { ...cached, model: narrow(cached.all, filtersOf(t)), layout: t.layout ?? cached.all.natural }
  const config = parseBase(source)
  const view = config.views[Math.min(t.view, config.views.length - 1)] ?? config.views[0]
  if (!view) throw new Error('the base has no views')
  const thisFile = new FileV(t.rel, {}, now, now, source.length, [], [])
  const all = buildModel({ config, view, files: vault.files, taskOf: vault.taskOf, ctx: { now, thisFile, resolve: vault.resolve } })
  evaluations.clear()
  evaluations.set(key, { config, vault, all, now })
  return { config, vault, all, model: narrow(all, filtersOf(t)), layout: t.layout ?? all.natural, now }
}

/** A short text account of what the pane shows: the model tool's answer and the terminal's pane. */
function summarize(d: Drawn, t: TasksTarget): string {
  const { model, all, config, vault, now } = d
  const f = filtersOf(t)
  const filter = [...f.projects.map(p => `project ${p}`), ...f.contexts.map(c => `context @${c}`)].join(', ')
  const head = filter
    ? `${model.view.name} (${model.view.type}), filtered to ${filter}: ${model.matched} of ${all.matched} tasks`
    : `${model.view.name} (${model.view.type}): ${model.matched} task${model.matched === 1 ? '' : 's'}`
  if (d.layout === 'agenda') {
    const agenda = buildAgenda(model.tasks, now, Number(model.view.options.listDayCount) || 7)
    const days = agenda.days.filter(x => x.items.length).map(x => `${dayLabel(x.date, now)} ${x.items.length}`)
    return `${head}; overdue ${agenda.overdue.length}${days.length ? `; ${days.join(', ')}` : ''}`
  }
  if (d.layout === 'graph') {
    const g = buildGraph(model.tasks, vault.tasks, { hideDone: !!t.hideDone })
    return `${head}; ${g.edges.length} dependencies among ${g.nodes.length} tasks; critical path ${Math.round(g.criticalDays * 10) / 10} days`
  }
  const columns = columnsOf(model, config, vault.settings, vault.tasks, now, d.layout === 'board' ? 'board' : 'list')
  if (columns.length === 1 && columns[0]?.key === 'all') return head
  return `${head}; ${columns.map(c => `${c.label} ${c.cards.length}`).join(', ')}`
}

async function show($: EngineInterface, args: Parsed): Promise<string> {
  const located = await locate($, args.what)
  if ('error' in located) return `tasknotes-preview: ${located.error}`
  const config = parseBase(await $.fs.read(located.real))
  const view = pickView(config, args.view)
  if (typeof view !== 'number') return `tasknotes-preview: ${located.rel}: ${view.error}`
  const value: TasksTarget = { ...located, view, expanded: [], orientation: 'landscape', zoom: 1, pan: 0, rev: Date.now() }
  if (args.layout) value.layout = args.layout
  if (args.projects?.length) value.projects = args.projects
  if (args.contexts?.length) value.contexts = args.contexts
  await $.state.set({ ...TARGET, id: PANE }, value)
  const isOpen = await $.ui.panes().then(ps => ps.some(p => p.id === PANE)).catch(() => false)
  if (isOpen) await $.ui.close({ id: PANE }).catch(() => undefined)
  const viewName = config.views[view]?.name ?? 'view'
  const opened = await $.ui.open({ id: PANE, title: `Tasks · ${viewName}`, focus: true })
  let account = ''
  try {
    account = summarize(await evaluate($, value), value)
  } catch (err) {
    account = `could not evaluate it: ${errorText(err)}`
  }
  return opened.isPlaced
    ? `Showing ${located.rel} in the Tasks pane. ${account}`
    : `The Tasks pane holds ${located.rel} but is not placed yet (${opened.reason}). ${account}`
}

// ── hooks ────────────────────────────────────────────────────────────────

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'taskboard',
      description: 'Show TaskNotes tasks from a .base view: board, list, agenda or dependency graph',
      argumentHint: '[kanban|tasks|agenda|calendar|<file.base>] [view] [--board|--list|--agenda|--graph] [--project=A,B] [--context=X]',
    })
    await $.tool.register({
      name: 'open',
      description:
        "Show the person's TaskNotes tasks in a side pane, evaluated from an Obsidian Bases (.base) view the way " +
        'Obsidian shows it: as a kanban board, a grouped list, an agenda of the coming days, or a dependency graph ' +
        '(blockedBy arrows with the critical path). Returns a short account of what it shows (counts per column). ' +
        'base: a .base path, or one of kanban, tasks, agenda, calendar, relationships (the files TaskNotes opens ' +
        'for those commands); default tasks. view: a view name or 1-based number. layout: board, list, agenda or graph. ' +
        'project / context: narrow the view to tasks in these projects or contexts (comma-separated names).',
      inputSchema: {
        type: 'object',
        properties: {
          base: { type: 'string', description: 'A .base path, or kanban | tasks | agenda | calendar | relationships' },
          view: { type: 'string', description: 'Optional view name or 1-based number' },
          layout: { type: 'string', enum: LAYOUTS, description: 'Optional: board, list, agenda or graph' },
          project: { type: 'string', description: 'Optional: only tasks in these projects (comma-separated)' },
          context: { type: 'string', description: 'Optional: only tasks with these contexts (comma-separated)' },
        },
      },
    })
    return next(e)
  })

  on('command.run', { command: 'taskboard' }, async ($, e) => ({ text: await show($, parseArgs(e.args)) }))

  on('tool.call', { tool: 'mcp__tasknotes-preview__open' }, async ($, e) => {
    const parsed: Parsed = { what: cleanArg(String(e.base ?? '')) || 'tasks' }
    if (e.view !== undefined && String(e.view).trim()) parsed.view = String(e.view).trim()
    if (typeof e.layout === 'string' && (LAYOUTS as string[]).includes(e.layout)) parsed.layout = e.layout as Layout
    if (names(e.project).length) parsed.projects = names(e.project)
    if (names(e.context).length) parsed.contexts = names(e.context)
    return { result: await show($, parsed) }
  })

  // Redraw after the agent writes a task note, the base, or TaskNotes' settings.
  for (const tool of ['Write', 'Edit'] as const) {
    on('tool.call', { tool }, async ($, e, next) => {
      const ran = await next(e)
      if (ran.deny !== undefined || ran.isError) return ran
      const path = String(e.file_path ?? '')
      const ref = { ...TARGET, id: PANE }
      const { value } = await $.state.get(ref)
      if (value && (samePath(path, value.real) || (isInside(path, value.root) && /\.(md|json|base)$/i.test(path)))) {
        await update($, ref, cur => (cur ? { ...cur, rev: cur.rev + 1 } : cur))
      }
      return ran
    })
  }

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ref = memberOf(TARGET, e)
    const { value: t } = await $.state.get(ref)
    const patch = (change: Partial<TasksTarget>) => update($, ref, cur => (cur ? { ...cur, ...change, rev: cur.rev + 1 } : cur))
    const open = async (rel: string) => {
      if (!t) return
      const target: Target = { rel, real: joinPath(t.root, rel), ...(t.vault ? { vault: t.vault } : {}) }
      try {
        $.ui.toast(`Opened ${rel} in Obsidian (${await openInObsidian($, target)})`)
      } catch (err) {
        $.ui.toast(`Could not open Obsidian: ${errorText(err)}`)
      }
    }
    const empty = 'No tasks open. Run /taskboard, or /taskboard kanban, or /taskboard <file.base>.'

    let drawn: Drawn | undefined
    let failure: string | undefined
    if (t) {
      try {
        drawn = await evaluate($, t)
      } catch (err) {
        failure = errorText(err)
      }
    }

    if (e.surface === 'terminal') {
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          <Text>{t ? t.rel : empty}</Text>
          {drawn && <Text>{summarize(drawn, t as TasksTarget)}</Text>}
          {failure && <Text color="red">{failure}</Text>}
          <Text dimColor>The board, agenda and graph are drawn in the Desktop Code tab.</Text>
        </Box>
      )
    }

    const elements = $.ui.resolve(e)
    const { Box, Text, Button, Svg } = elements
    const Select = 'Select' in elements ? elements.Select : undefined
    if (!t) return <Text dimColor>{empty}</Text>
    if (!drawn) return <Text color="red">Cannot show {t.rel}: {failure}</Text>

    const { model, all, config, vault, layout, now } = drawn
    const filters = filtersOf(t)
    const filtering = filters.projects.length + filters.contexts.length > 0
    const settings = vault.settings
    const isExpanded = (key: string) => t.expanded.includes(`${layout}:${key}`)
    const expand = (key: string) => patch({ expanded: [...t.expanded, `${layout}:${key}`] })
    const collapse = (key: string) => patch({ expanded: t.expanded.filter(k => k !== `${layout}:${key}`) })

    const cardView = (card: Card, compact: boolean) => (
      <Box key={`card:${card.key}`} flexDirection="column" borderStyle="round" borderColor={card.color ?? 'gray'} paddingX={1} marginBottom={compact ? 0 : 1}>
        <Box flexDirection="row" gap={1} alignItems="flex-start">
          <Text color={card.color ?? 'gray'}>●</Text>
          <Box flexGrow={1} flexShrink={1}>
            <Text bold={!card.done} strikethrough={card.done} dimColor={card.done} wrap="wrap">{card.title}</Text>
          </Box>
          <Button key={`open:${card.path}`} label="↗" plain dimColor onPress={() => open(card.path)} />
        </Box>
        {card.meta.length > 0 && (
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            {card.meta.map((m, k) => (
              <Text key={`${card.key}:m${k}`} {...(m.color ? { color: m.color } : { dimColor: true })}>{m.text}</Text>
            ))}
          </Box>
        )}
      </Box>
    )

    const more = (key: string, total: number) =>
      total > CAP && (isExpanded(key)
        ? <Button key={`less:${key}`} label="Show fewer" dimColor onPress={() => collapse(key)} />
        : <Button key={`more:${key}`} label={`Show all ${total}`} dimColor onPress={() => expand(key)} />)

    const columnView = (col: Column, board: boolean) => {
      const shown = isExpanded(col.key) ? col.cards : col.cards.slice(0, CAP)
      return (
        <Box key={`col:${col.key}`} flexDirection="column" flexGrow={1} flexShrink={1} {...(board ? { minWidth: 30, width: 34 } : {})}>
          <Box flexDirection="row" gap={1}>
            <Text color={col.color ?? 'gray'}>●</Text>
            <Text bold>{col.label}</Text>
            <Text dimColor>{col.cards.length}</Text>
          </Box>
          {col.cards.length === 0 && <Text dimColor italic>No tasks</Text>}
          {shown.map(card => cardView(card, false))}
          {more(col.key, col.cards.length)}
        </Box>
      )
    }

    const agendaRow = (item: AgendaItem, k: number, overdue: boolean) => {
      const status = item.task.statusDef
      const kind = item.kind === 'recurring' ? '↻' : item.kind === 'due' ? 'due' : 'sched'
      return (
        <Box key={`ag:${item.task.file.path}:${item.date}:${k}`} flexDirection="row" gap={1}>
          <Text color={status?.color ?? 'gray'}>●</Text>
          <Text {...(overdue ? { color: '#d62728' } : { dimColor: true })}>{overdue ? dayLabel(item.date, now) : kind}</Text>
          <Box flexGrow={1} flexShrink={1}>
            <Text wrap="wrap">{item.task.title}</Text>
          </Box>
          {item.task.priorityDef && item.task.priority !== 'none' && <Text color={item.task.priorityDef.color}>{item.task.priorityDef.label}</Text>}
          <Button key={`open:${item.task.file.path}:${item.date}`} label="↗" plain dimColor onPress={() => open(item.task.file.path)} />
        </Box>
      )
    }

    // Pills: the projects and contexts of the whole view, most used first. A press toggles one;
    // several in a row widen (any of them), the two rows narrow each other (both must hold).
    const facetsOf = facets(all.tasks)
    const PILLS = 10
    const pillRow = (kind: 'project' | 'context', label: string, list: Facet[], selected: string[], prefix: string) => {
      if (!list.length) return undefined
      const chosen = selected.map(s => s.toLowerCase())
      const field = kind === 'project' ? 'projects' : 'contexts'
      const toggle = (name: string) =>
        patch({ [field]: chosen.includes(name.toLowerCase()) ? selected.filter(s => s.toLowerCase() !== name.toLowerCase()) : [...selected, name] } as Partial<TasksTarget>)
      // Selected pills always show, even beyond the cap.
      const visible = t.allPills ? list : list.filter((f, i) => i < PILLS || chosen.includes(f.name.toLowerCase()))
      return (
        <Box key={`pills-${kind}`} flexDirection="row" flexWrap="wrap" gap={1} alignItems="center">
          <Text dimColor>{label}</Text>
          {visible.map(f => (
            <Button
              key={`pill-${kind}:${f.name}`}
              label={`${prefix}${f.name} ${f.count}`}
              {...(chosen.includes(f.name.toLowerCase()) ? { variant: 'primary' as const } : { dimColor: true })}
              onPress={() => toggle(f.name)}
            />
          ))}
          {list.length > PILLS && (
            <Button key={`pills-more-${kind}`} label={t.allPills ? 'Fewer' : `+${list.length - visible.length} more`} dimColor onPress={() => patch({ allPills: !t.allPills })} />
          )}
        </Box>
      )
    }

    let body: ReturnType<typeof Text>
    let caption = filtering
      ? `${model.matched} of ${all.matched} tasks`
      : `${model.matched} task${model.matched === 1 ? '' : 's'}${model.shown < model.matched ? ` (first ${model.shown})` : ''}`
    if (layout === 'board' || layout === 'list') {
      const columns = columnsOf(model, config, settings, vault.tasks, now, layout)
      body = layout === 'board'
        ? <Box flexDirection="row" flexWrap="wrap" gap={2}>{columns.map(c => columnView(c, true))}</Box>
        : <Box flexDirection="column" gap={1}>{columns.map(c => columnView(c, false))}</Box>
    } else if (layout === 'agenda') {
      const days = Number(model.view.options.listDayCount) || 7
      const agenda = buildAgenda(model.tasks, now, days)
      const overdueShown = isExpanded('overdue') ? agenda.overdue : agenda.overdue.slice(0, CAP)
      caption += ` · next ${agenda.days.length} days`
      body = (
        <Box flexDirection="column" gap={1}>
          {agenda.overdue.length > 0 && (
            <Box key="overdue" flexDirection="column">
              <Text bold color="#d62728">Overdue · {agenda.overdue.length}</Text>
              {overdueShown.map((item, k) => agendaRow(item, k, true))}
              {more('overdue', agenda.overdue.length)}
            </Box>
          )}
          {agenda.days.map(day => (
            <Box key={`day:${day.date}`} flexDirection="column">
              <Box flexDirection="row" gap={1}>
                <Text bold>{dayLabel(day.date, now)}</Text>
                <Text dimColor>{day.items.length}</Text>
              </Box>
              {day.items.length === 0 && <Text dimColor italic>Nothing due or scheduled</Text>}
              {day.items.map((item, k) => agendaRow(item, k, false))}
            </Box>
          ))}
        </Box>
      )
    } else {
      const graph = buildGraph(model.tasks, vault.tasks, { hideDone: !!t.hideDone })
      const dots = graph.nodes.filter(n => n.task?.done && !n.missing).length
      const zoom = t.zoom > 0 ? t.zoom : 1
      const view = graph.nodes.length ? zoomView(graphSvg(graph, settings, t.orientation), zoom, t.pan) : undefined
      caption += ` · ${graph.edges.length} dependenc${graph.edges.length === 1 ? 'y' : 'ies'}` +
        (graph.criticalDays ? ` · critical path ${Math.round(graph.criticalDays * 10) / 10} days (red)` : '') +
        (graph.isolated ? ` · ${graph.isolated} without dependencies not drawn` : '') +
        (graph.cycles ? ` · ${graph.cycles} in a cycle` : '') +
        (dots ? ` · ${dots} done shown as dots (hover for the card)` : '') +
        (view ? ` · ${t.orientation} · ${zoomLabel(zoom, view.from, view.to)}` : '')
      const panBy = (direction: 1 | -1) => patch({ pan: Math.min(1, Math.max(0, t.pan + direction * panStep(zoom))) })
      body = (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" gap={2} flexWrap="wrap" alignItems="center">
            <Button
              key="orientation"
              label={t.orientation === 'landscape' ? 'Switch to portrait' : 'Switch to landscape'}
              onPress={() => patch({ orientation: t.orientation === 'landscape' ? 'portrait' : 'landscape' })}
            />
            <Button key="zoom-out" label="−" onPress={() => patch({ zoom: stepZoom(zoom, -1) })} />
            <Button key="zoom-fit" label="Fit" onPress={() => patch({ zoom: 1, pan: 0 })} />
            <Button key="zoom-in" label="+" onPress={() => patch({ zoom: stepZoom(zoom, 1) })} />
            {zoom > 1 && <Button key="pan-left" label="◀" onPress={() => panBy(-1)} />}
            {zoom > 1 && <Button key="pan-right" label="▶" onPress={() => panBy(1)} />}
            {/* One press: finished tasks as dots, or not at all. */}
            <Button key="done-toggle" label={t.hideDone ? 'Show done' : 'Hide done'} onPress={() => patch({ hideDone: !t.hideDone })} />
          </Box>
          {!view && <Text dimColor italic>No task in this view has a blockedBy dependency.</Text>}
          {view && (view.svg.length > SVG_LIMIT
            ? <Text>The graph is too large for the pane ({view.svg.length.toLocaleString('en')} characters); pick a narrower view.</Text>
            : <Svg source={view.svg} isInteractive alt={`Dependency graph of ${model.view.name}: ${graph.nodes.length} tasks, ${graph.edges.length} dependencies`} />)}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Text bold wrap="truncate-middle">{t.rel}</Text>
        <Box flexDirection="row" gap={2} alignItems="center" flexWrap="wrap">
          {Select && config.views.length > 1 && (
            <Select
              key="view"
              label="View"
              value={String(Math.min(t.view, config.views.length - 1))}
              options={config.views.map((v, k) => ({ value: String(k), label: v.name }))}
              onSelect={v =>
                update($, ref, cur => {
                  if (!cur) return cur
                  // A new view is drawn its own way again.
                  const { layout: _drop, ...rest } = cur
                  return { ...rest, view: Number(v), expanded: [], zoom: 1, pan: 0, rev: cur.rev + 1 }
                })
              }
            />
          )}
          {/* Four ways to draw the same rows: one press each, the current one marked. */}
          {LAYOUTS.map(l => (
            <Button key={`layout-${l}`} label={LAYOUT_LABEL[l]} {...(l === layout ? { variant: 'primary' as const } : {})} onPress={() => patch({ layout: l })} />
          ))}
          <Button key="refresh" label="Refresh" onPress={() => patch({})} />
          {t.vault && <Button key="open-base" label="Open in Obsidian" onPress={() => open(t.rel)} />}
        </Box>
        <Text dimColor>{model.view.name} · {caption}{settings.found ? '' : ' · TaskNotes settings not found, using defaults'}</Text>
        <Text dimColor>
          Filters run over the {vault.files.length.toLocaleString('en')} notes in {settings.tasksFolder} and {settings.archiveFolder}, not the whole vault.
        </Text>
        {pillRow('project', 'Projects', facetsOf.projects, filters.projects, '')}
        {pillRow('context', 'Contexts', facetsOf.contexts, filters.contexts, '@')}
        {filtering && <Button key="pills-clear" label="Clear filters" dimColor onPress={() => patch({ projects: [], contexts: [] })} />}
        {model.warnings.length > 0 && (
          <Text dimColor italic>
            Note: skipped what this renderer cannot read ({model.warnings.length}): {model.warnings.slice(0, 3).join('; ')}{model.warnings.length > 3 ? '; …' : ''}
          </Text>
        )}
        {body}
      </Box>
    )
  })
}
