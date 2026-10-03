import { expect, test } from 'claude-code/testing'

import { buildAgenda, occursOn, parseRecurrence } from '../hooks/agenda'
import { evaluateView, parseBase } from '../hooks/bases'
import { DateV, Evaluator, FileV, Unsupported, formatDate, linkKey, toDate, toDuration } from '../hooks/expr'
import { buildGraph, graphSvg } from '../hooks/graph'
import { columnsOf, buildModel } from '../hooks/model'
import { blockerTargets, parseSettings, sectionProgress, toTask } from '../hooks/tasknotes'
import { parseYaml, splitFrontmatter } from '../hooks/yaml'
import { AGENDA_BASE, KANBAN_BASE, SETTINGS, TASKS, TASKS_BASE, day } from './fixtures'

const settings = parseSettings(SETTINGS)

function fileOf(rel: string, text: string): { file: FileV; body: string } {
  const { data, body } = splitFrontmatter(text)
  const raw = data.tags
  const tags = (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,]+/) : []).map(String)
  const links = [...text.matchAll(/\[\[([^\]|#]+)/g)].map(m => m[1] ?? '')
  return { file: new FileV(rel, data, Date.now(), Date.now(), text.length, tags, links), body }
}

const vault = Object.entries(TASKS).map(([rel, text]) => fileOf(rel, text))
const files = vault.map(v => v.file)
const bodies = new Map(vault.map(v => [v.file, v.body]))
const taskOf = (f: FileV) => toTask(f, bodies.get(f) ?? '', settings)
const allTasks = files.map(taskOf)
const resolve = (target: string) => files.find(f => linkKey(f) === linkKey(target))
const ctx = { now: Date.now(), resolve }
const names = (rows: { file: FileV }[]) => rows.map(r => r.file.basename)

// ── YAML ─────────────────────────────────────────────────────────────────

test('yaml: TaskNotes frontmatter shapes', async () => {
  const fm = (rel: string) => splitFrontmatter(TASKS[rel] ?? '').data
  expect(fm('TaskNotes/Tasks/Write docs.md').blockedBy).toEqual([{ uid: '[[Build API]]', reltype: 'FINISHTOSTART' }])
  expect(fm('TaskNotes/Tasks/Launch.md').blockedBy).toEqual(['[[Write docs]]', '[[Build API]]']) // sequence at its key's indent
  expect(fm('TaskNotes/Tasks/Build API.md').assignee).toEqual(['agent'])
  expect(fm('TaskNotes/Archive/Old task.md').tags).toEqual(['task', 'archived'])
  expect(fm('TaskNotes/Tasks/Pay invoice.md').awaiting).toBe('Waiting for the supplier to send the corrected invoice')
  expect(fm('TaskNotes/Tasks/Write docs.md').scheduled).toBe(day(5)) // dates stay text
  expect(fm('TaskNotes/Tasks/Design schema.md').size).toBe('S')
})

test('yaml: scalars, multi-line quotes, block scalars, comments and expressions with colons', async () => {
  const doc = parseYaml([
    'a: 06:00:00',
    'b: 12',
    'c: "one',
    '  two"',
    'd: |',
    '  line 1',
    '  line 2',
    'e: null',
    'f: plain # a comment',
    'g:',
    '  - x == "a: b"',
    '  - key: v',
    '    other: w',
    "h: 'it''s'",
    'i: {x: 1, y: [a, "b c"]}',
  ].join('\n'))
  expect(doc).toEqual({
    a: '06:00:00',
    b: 12,
    c: 'one two',
    d: 'line 1\nline 2\n',
    e: null,
    f: 'plain',
    g: ['x == "a: b"', { key: 'v', other: 'w' }],
    h: "it's",
    i: { x: 1, y: ['a', 'b c'] },
  })
})

test('bases: views, nested filters, sort and options are read', async () => {
  const config = parseBase(TASKS_BASE)
  expect(config.views.map(v => v.name)).toEqual(['Not Blocked', 'This Week', 'TableView', 'Odd'])
  expect(config.views[0]?.sort).toEqual([{ property: 'formula.urgencyScore', direction: 'DESC' }])
  expect(Object.keys(config.formulas)).toContain('urgencyScore')
  const kanban = parseBase(KANBAN_BASE).views[0]
  expect(kanban?.groupBy).toEqual({ property: 'status', direction: 'ASC' })
  expect(kanban?.options.hideEmptyColumns).toBe(false)
  expect(parseBase(AGENDA_BASE).views[0]?.options.listDayCount).toBe(7)
})

// ── expressions ──────────────────────────────────────────────────────────

test('expr: arithmetic, lambdas, strings, durations and dates', async () => {
  const ev = new Evaluator({ file: files[1] as FileV, formulas: {}, resolve, now: Date.now() })
  expect(ev.eval('[1, 2, 3].filter(value > 1).map(value * 2).reduce(acc + value, 0)')).toBe(10)
  expect(ev.eval('"Abc".contains("b") && "abc".startsWith("a")')).toBe(true)
  expect(ev.eval('today() + "7 days" == today() + "1 week"')).toBe(true)
  expect(ev.eval('date(due) > today()')).toBe(true)
  expect(ev.eval('list(projects).contains(link("Platform"))')).toBe(true)
  expect(ev.eval('file.hasTag("task")')).toBe(false)
  expect(ev.eval('file.inFolder("TaskNotes/Tasks")')).toBe(true)
  expect(ev.eval('(10 / 4).round(1)')).toBe(2.5)
  expect(ev.eval('["queue/decision", "x"].hasTag("queue")')).toBe(true)
  expect(ev.eval('list(assignee).contains("Agent")')).toBe(false) // case counts, as in Obsidian
  expect(ev.eval('["#task"].contains("task")')).toBe(true)
  expect(toDuration('1 week 2 days')?.ms).toBe(9 * 86400000)
  expect(toDate('2026-10-03T07:00:00Z')?.ms).toBe(Date.UTC(2026, 9, 3, 7))
  expect(toDate('2026-10-03 09:00:00+02:00')?.ms).toBe(Date.UTC(2026, 9, 3, 7))
  expect((toDate('2026-10-03') as DateV).hasTime).toBe(false)
  expect(formatDate(new Date(2026, 0, 1).getTime(), 'YYYY-[W]WW ddd')).toBe('2026-W01 Thu')
  expect(() => ev.eval('icon("x")')).toThrow(Unsupported)
})

test('expr: the TaskNotes default formulas', async () => {
  const config = parseBase(TASKS_BASE)
  const formulasFor = (rel: string) => new Evaluator({ file: files.find(f => f.path === rel) as FileV, formulas: config.formulas, resolve, now: Date.now() })
  const build = formulasFor('TaskNotes/Tasks/Build API.md')
  expect(build.formula('daysUntilDue')).toBe(2)
  expect(build.formula('urgencyScore')).toBe(11) // high (3) + 10 - 2 days
  expect(build.formula('dueDateDisplay')).toBe(formatDate(toDate(day(2))!.ms, 'ddd'))
  const launch = formulasFor('TaskNotes/Tasks/Launch.md')
  expect(launch.formula('dueDateDisplay')).toBe('Yesterday')
  expect(formulasFor('TaskNotes/Tasks/Pay invoice.md').formula('dueDateDisplay')).toBe('Today')
  expect(formulasFor('TaskNotes/Tasks/Daily review.md').formula('urgencyScore')).toBe(2) // no dates: weight only
})

// ── views ────────────────────────────────────────────────────────────────

test('views: "Not Blocked" resolves blockers through file() and both blockedBy shapes', async () => {
  const config = parseBase(TASKS_BASE)
  const result = evaluateView(config, config.views[0]!, files, ctx)
  expect(names(result.rows)).toEqual(['Build API', 'Pay invoice']) // urgency 11 each, then by name
  expect(result.warnings).toEqual([])
})

test('views: "This Week" uses date arithmetic; a recurring task done today is left out', async () => {
  const config = parseBase(TASKS_BASE)
  const result = evaluateView(config, config.views[1]!, files, ctx)
  expect(names(result.rows)).toEqual(['Build API', 'Pay invoice', 'Write docs'])
})

test('views: an unsupported filter part is skipped and reported', async () => {
  const config = parseBase(TASKS_BASE)
  const result = evaluateView(config, config.views[3]!, files, ctx)
  expect(result.rows.length).toBe(6)
  expect(result.warnings[0]).toContain('file.backlinks is not supported')
})

test('board: status columns in TaskNotes order, empty ones kept, labels and colours from settings', async () => {
  const config = parseBase(KANBAN_BASE)
  const model = buildModel({ config, view: config.views[0]!, files, taskOf, ctx })
  const columns = columnsOf(model, config, settings, allTasks, Date.now(), 'board')
  expect(columns.map(c => `${c.label} ${c.cards.length}`)).toEqual(['None 0', 'Backlog 1', 'Next 2', 'In progress 1', 'Awaiting Input 1', 'Done 1', 'Cancelled 0'])
  expect(columns[3]?.color).toBe('#0066cc')
  const launch = columns[2]?.cards.find(c => c.title === 'Launch')
  expect(launch?.meta.map(m => m.text)).toContain('⛔ blocked by 2')
  expect(launch?.meta.find(m => m.text.startsWith('due'))?.text).toContain('(overdue)')
  const build = columns[3]?.cards[0]
  expect(build?.meta.map(m => m.text)).toEqual(['High priority', `due ${formatDate(toDate(day(2))!.ms, 'ddd D MMM')}`, '▸ Platform', 'done when 2/3'])
})

test('list: a table view groups by status and shows its formula columns', async () => {
  const config = parseBase(TASKS_BASE)
  const model = buildModel({ config, view: config.views[2]!, files, taskOf, ctx })
  const sections = columnsOf(model, config, settings, allTasks, Date.now(), 'list')
  expect(sections.map(s => s.label)).toEqual(['Backlog', 'Next', 'In progress', 'Awaiting Input', 'Done'])
  const build = sections[2]?.cards[0]
  expect(build?.meta.map(m => m.text)).toContain('urgencyScore: 11')
})

// ── tasks ────────────────────────────────────────────────────────────────

test('tasks: Done When progress, blockedBy targets, status from settings', async () => {
  const build = allTasks.find(t => t.title === 'Build API')
  expect(build?.doneWhen).toEqual({ done: 2, total: 3 })
  expect(build?.statusDef?.label).toBe('In progress')
  expect(blockerTargets([{ uid: '[[A]]' }, '[[B|alias]]', 'C'])).toEqual(['A', 'B', 'C'])
  expect(sectionProgress('# T\n## Ready When\n- [x] R1\n- [ ] R2\n## Done When\n- [x] AC1', ['Ready When'])).toEqual({ done: 1, total: 2 })
  expect(allTasks.find(t => t.title === 'Design schema')?.done).toBe(true)
})

// ── agenda ───────────────────────────────────────────────────────────────

test('recurrence: TaskNotes shorthand and RFC 5545 rules', async () => {
  const at = (s: string) => toDate(s)!.ms
  const monthly = parseRecurrence('DTSTART:20260406;monthly')!
  expect([occursOn(monthly, at('2026-05-06')), occursOn(monthly, at('2026-05-07')), occursOn(monthly, at('2026-03-06'))]).toEqual([true, false, false])
  const quarterly = parseRecurrence('DTSTART:20260801;FREQ=MONTHLY;INTERVAL=3')!
  expect([occursOn(quarterly, at('2026-11-01')), occursOn(quarterly, at('2026-09-01'))]).toEqual([true, false])
  const weekdays = parseRecurrence('FREQ=WEEKLY;BYDAY=MO,WE', at('2026-10-05'))!
  expect([occursOn(weekdays, at('2026-10-07')), occursOn(weekdays, at('2026-10-08'))]).toEqual([true, false])
  expect(parseRecurrence('daily')).toBeUndefined() // no start date known
})

test('agenda: overdue first, due and scheduled by day, recurring instances minus completed ones', async () => {
  const config = parseBase(AGENDA_BASE)
  const model = buildModel({ config, view: config.views[0]!, files, taskOf, ctx })
  const agenda = buildAgenda(model.tasks, Date.now(), 7)
  expect(agenda.overdue.map(i => i.task.title)).toEqual(['Launch'])
  const titles = agenda.days.map(d => d.items.map(i => `${i.kind}:${i.task.title}`))
  expect(titles[0]).toEqual(['due:Pay invoice']) // the daily review is already done today
  expect(titles[1]).toEqual(['recurring:Daily review'])
  expect(titles[2]).toEqual(['due:Build API', 'recurring:Daily review']) // high priority first
  expect(titles[5]).toEqual(['recurring:Daily review', 'scheduled:Write docs'])
})

// ── graph ────────────────────────────────────────────────────────────────

test('graph: layers, the critical path by size, isolated tasks counted', async () => {
  const config = parseBase(KANBAN_BASE)
  const model = buildModel({ config, view: config.views[0]!, files, taskOf, ctx })
  const graph = buildGraph(model.tasks, allTasks)
  const level = (title: string) => graph.nodes.find(n => n.title === title)?.level
  expect([level('Design schema'), level('Build API'), level('Write docs'), level('Launch')]).toEqual([0, 1, 2, 3])
  expect(graph.edges.length).toBe(4)
  expect(graph.criticalDays).toBe(14) // M 2 + L 4 + XL 8; the done task adds nothing
  expect(graph.nodes.filter(n => n.critical).map(n => n.title).sort()).toEqual(['Build API', 'Launch', 'Write docs'])
  expect(graph.edges.find(e => e.from === 'build api' && e.to === 'launch')?.critical).toBe(false)
  expect(graph.isolated).toBe(2)
  const wide = graphSvg(graph, settings, 'landscape')
  const tall = graphSvg(graph, settings, 'portrait')
  const size = (svg: string) => /width="(\d+)" height="(\d+)"/.exec(svg)!.slice(1).map(Number)
  expect(size(wide)[0]!).toBeGreaterThan(size(wide)[1]!)
  expect(size(tall)[1]!).toBeGreaterThan(size(tall)[0]!)
  expect(wide).toContain('#d62728')
  expect(wide).not.toContain('<script')
})

test('graph: a missing blocker and a cycle are drawn and flagged', async () => {
  const a = fileOf('T/A.md', '---\ntype: task\nstatus: open\nblockedBy: ["[[B]]", "[[Ghost]]"]\n---\n')
  const b = fileOf('T/B.md', '---\ntype: task\nstatus: open\nblockedBy: ["[[A]]"]\n---\n')
  const tasks = [a, b].map(v => toTask(v.file, v.body, settings))
  const graph = buildGraph(tasks, tasks)
  expect(graph.cycles).toBe(2)
  expect(graph.nodes.find(n => n.missing)?.title).toBe('Ghost')
  expect(graphSvg(graph, settings, 'landscape')).toContain('not found: Ghost')
})
