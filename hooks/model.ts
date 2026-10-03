// What a pane shows for one view of a base: its rows as TaskNotes tasks, grouped into board
// columns or list sections, each card with the properties the view's `order` names.
// Pure: register.tsx loads the files and draws what this returns.

import type { Layout } from '../types'
import { displayName, evaluateView, groupRows } from './bases'
import type { BaseConfig, BaseView, EvalContext, Row } from './bases'
import { FileV, formatDate, toText } from './expr'
import { findTask, fieldKey, priorityOrder, statusLabel, statusOrder, taskIndex } from './tasknotes'
import type { Task, TaskNotesSettings } from './tasknotes'

export type MetaItem = { text: string; color?: string }

export type Card = {
  key: string
  path: string
  title: string
  status: string
  color?: string
  done: boolean
  meta: MetaItem[]
}

export type Column = { key: string; label: string; color?: string; cards: Card[] }

export type Model = {
  view: BaseView
  /** The layout the view's own type asks for. */
  natural: Exclude<Layout, 'graph'>
  matched: number
  shown: number
  warnings: string[]
  rows: Row[]
  /** The rows' tasks, in the view's sort order. */
  tasks: Task[]
}

export function naturalLayout(type: string): Exclude<Layout, 'graph'> {
  const t = type.toLowerCase()
  if (t.includes('kanban') || t === 'board') return 'board'
  if (t.includes('calendar') || t.includes('agenda')) return 'agenda'
  return 'list'
}

export type ModelInput = {
  config: BaseConfig
  view: BaseView
  files: FileV[]
  taskOf: (file: FileV) => Task
  ctx: EvalContext
}

export function buildModel({ config, view, files, taskOf, ctx }: ModelInput): Model {
  const result = evaluateView(config, view, files, ctx)
  return {
    view,
    natural: naturalLayout(view.type),
    matched: result.matched,
    shown: result.rows.length,
    warnings: result.warnings,
    rows: result.rows,
    tasks: result.rows.map(r => taskOf(r.file)),
  }
}

function isProp(prop: string, settings: TaskNotesSettings, field: string): boolean {
  const key = fieldKey(settings, field)
  return prop === key || prop === `note.${key}`
}

function shortDate(ms: number, now: number): string {
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear()
  return formatDate(ms, sameYear ? 'ddd D MMM' : 'D MMM YYYY')
}

function startOfDay(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

const SKIP = new Set(['file.name', 'file.basename', 'title', 'note.title', 'file.tags', 'tags', 'note.tags', 'complete_instances', 'note.complete_instances'])

/**
 * A card: the title, then the view's `order` properties TaskNotes knows how to show
 * (status, priority, due, …), then Done When progress. `extras` adds the other properties
 * the view lists (formulas, custom fields) as `name: value`, as a table view shows them.
 */
export function cardOf(
  row: Row,
  task: Task,
  config: BaseConfig,
  settings: TaskNotesSettings,
  index: Map<string, Task>,
  now: number,
  opts: { order: string[]; groupProp?: string; extras?: boolean },
): Card {
  const meta: MetaItem[] = []
  const props = [...new Set(opts.order.length ? opts.order : DEFAULT_ORDER)]
  const today = startOfDay(now)
  for (const prop of props) {
    if (SKIP.has(prop) || prop === opts.groupProp) continue
    if (isProp(prop, settings, 'status')) {
      meta.push({ text: task.statusDef?.label ?? task.status, ...(task.statusDef ? { color: task.statusDef.color } : {}) })
    } else if (isProp(prop, settings, 'priority')) {
      if (task.priority !== 'none') meta.push({ text: `${task.priorityDef?.label ?? task.priority} priority`, ...(task.priorityDef ? { color: task.priorityDef.color } : {}) })
    } else if (isProp(prop, settings, 'due')) {
      if (task.due) {
        const late = !task.done && startOfDay(task.due.ms) < today
        meta.push({ text: `due ${shortDate(task.due.ms, now)}${late ? ' (overdue)' : ''}`, ...(late ? { color: '#d62728' } : {}) })
      }
    } else if (isProp(prop, settings, 'scheduled')) {
      if (task.scheduled) meta.push({ text: `scheduled ${shortDate(task.scheduled.ms, now)}` })
    } else if (isProp(prop, settings, 'projects')) {
      if (task.projects.length) meta.push({ text: `▸ ${task.projects.join(', ')}` })
    } else if (isProp(prop, settings, 'contexts')) {
      if (task.contexts.length) meta.push({ text: task.contexts.map(c => `@${c.replace(/^@/, '')}`).join(' ') })
    } else if (isProp(prop, settings, 'blockedBy')) {
      const open = task.blockedBy.filter(t => !findTask(index, t)?.done)
      if (open.length) meta.push({ text: `⛔ blocked by ${open.length}`, color: '#d62728' })
    } else if (isProp(prop, settings, 'recurrence')) {
      if (task.recurrence) meta.push({ text: `↻ ${recurrenceWord(task.recurrence)}` })
    } else if (prop === 'assignee' || prop === 'note.assignee') {
      if (task.assignee.length) meta.push({ text: `→ ${task.assignee.join(', ')}` })
    } else if (prop === 'size' || prop === 'note.size') {
      if (task.size) meta.push({ text: `size ${task.size}` })
    } else if (opts.extras) {
      const text = toText(row.get(prop))
      if (text) meta.push({ text: `${displayName(config, prop)}: ${text}` })
    }
  }
  if (task.doneWhen) meta.push({ text: `done when ${task.doneWhen.done}/${task.doneWhen.total}`, ...(task.doneWhen.done === task.doneWhen.total ? { color: '#00aa00' } : {}) })
  const card: Card = { key: task.file.path, path: task.file.path, title: task.title, status: task.status, done: task.done, meta }
  if (task.statusDef) card.color = task.statusDef.color
  return card
}

/** Card properties when a view lists none: TaskNotes' usual ones. */
const DEFAULT_ORDER = ['status', 'priority', 'due', 'scheduled', 'projects', 'contexts', 'blockedBy', 'recurrence']

/** Cards for the rows of `model`, with the view's own property order. */
export function cardsOf(model: Model, config: BaseConfig, settings: TaskNotesSettings, allTasks: Task[], now: number, groupProp?: string): Card[] {
  const index = taskIndex(allTasks)
  const extras = model.view.type.toLowerCase().includes('table')
  return model.rows.map((row, k) =>
    cardOf(row, model.tasks[k] as Task, config, settings, index, now, { order: model.view.order, extras, ...(groupProp ? { groupProp } : {}) }),
  )
}

function recurrenceWord(rule: string): string {
  const freq = /FREQ=(\w+)/i.exec(rule)?.[1] ?? /\b(daily|weekly|monthly|yearly)\b/i.exec(rule)?.[1] ?? 'recurring'
  const interval = Number(/INTERVAL=(\d+)/i.exec(rule)?.[1] ?? 1)
  const word = freq.toLowerCase()
  if (interval <= 1) return word
  const unit = { daily: 'days', weekly: 'weeks', monthly: 'months', yearly: 'years' }[word] ?? word
  return `every ${interval} ${unit}`
}

/**
 * Columns (board) or sections (list). The board groups by the view's groupBy, else status;
 * status columns follow TaskNotes' order and include empty ones unless the view hides them.
 * A list without groupBy is one section.
 */
export function columnsOf(
  model: Model,
  config: BaseConfig,
  settings: TaskNotesSettings,
  allTasks: Task[],
  now: number,
  layout: 'board' | 'list',
): Column[] {
  const spec = model.view.groupBy ?? (layout === 'board' ? { property: fieldKey(settings, 'status'), direction: 'ASC' as const } : undefined)
  if (!spec) {
    return [{ key: 'all', label: model.view.name, cards: cardsOf(model, config, settings, allTasks, now) }]
  }
  const byStatus = isProp(spec.property, settings, 'status')
  const byPriority = isProp(spec.property, settings, 'priority')
  const cards = cardsOf(model, config, settings, allTasks, now, spec.property)
  const cardByRow = new Map(model.rows.map((r, k) => [r, cards[k] as Card]))
  const groups = groupRows(model.rows, spec, keys => {
    if (byStatus) return statusOrder(settings, keys)
    if (byPriority) return priorityOrder(settings, keys)
    return undefined
  })
  const columns: Column[] = groups.map(g => {
    const col: Column = { key: g.key, label: byStatus ? statusLabel(settings, g.label) : g.label, cards: g.rows.map(r => cardByRow.get(r) as Card) }
    const color = byStatus ? settings.statuses.find(s => s.value.toLowerCase() === g.key)?.color : byPriority ? settings.priorities.find(p => p.value.toLowerCase() === g.key)?.color : undefined
    if (color) col.color = color
    return col
  })
  if (layout === 'board' && byStatus && model.view.options.hideEmptyColumns !== true) {
    for (const s of settings.statuses) {
      if (!columns.some(c => c.key === s.value.toLowerCase())) columns.push({ key: s.value.toLowerCase(), label: s.label, color: s.color, cards: [] })
    }
    const ordered = statusOrder(settings, columns.map(c => c.key))
    columns.sort((a, b) => ordered.indexOf(a.key) - ordered.indexOf(b.key))
    if (spec.direction === 'DESC') columns.reverse()
  }
  return columns
}
