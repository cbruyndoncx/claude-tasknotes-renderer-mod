// An Obsidian `.base` file: its views, and evaluating one over a set of files the way
// Obsidian does: global filters AND the view's filters, formulas, sort, limit, groupBy.
// Sort order follows bob-workspace's comparator (empty values last, then numbers, dates,
// numeric-aware text), by the same author, MIT.

import { Evaluator, FileV, Unsupported, compare, toDate, toText } from './expr'
import type { Env, Val } from './expr'
import { isRecord, parseYaml } from './yaml'

export type FilterNode = string | { and: FilterNode[] } | { or: FilterNode[] } | { not: FilterNode[] }
export type SortSpec = { property: string; direction: 'ASC' | 'DESC' }

export type BaseView = {
  type: string
  name: string
  filters?: FilterNode
  groupBy?: SortSpec
  sort: SortSpec[]
  order: string[]
  limit?: number
  /** Everything else on the view (`options:` merged with top-level extras). */
  options: Record<string, unknown>
}

export type BaseConfig = {
  filters?: FilterNode
  formulas: Record<string, string>
  displayNames: Record<string, string>
  views: BaseView[]
}

const VIEW_KEYS = new Set(['type', 'name', 'filters', 'groupBy', 'sort', 'order', 'limit', 'options'])

function asFilter(raw: unknown): FilterNode | undefined {
  if (raw === null || raw === undefined) return undefined
  if (typeof raw === 'string') return raw
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw)
  if (isRecord(raw)) {
    for (const key of ['and', 'or', 'not'] as const) {
      const list = raw[key]
      if (Array.isArray(list)) {
        const items = list.map(asFilter).filter((f): f is FilterNode => f !== undefined)
        return key === 'and' ? { and: items } : key === 'or' ? { or: items } : { not: items }
      }
    }
  }
  return undefined
}

function asSort(raw: unknown): SortSpec | undefined {
  if (typeof raw === 'string') return { property: raw, direction: 'ASC' }
  if (!isRecord(raw) || typeof raw.property !== 'string') return undefined
  return { property: raw.property, direction: String(raw.direction ?? 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC' }
}

export function parseBase(src: string): BaseConfig {
  const doc = parseYaml(src)
  const root = isRecord(doc) ? doc : {}
  const formulas: Record<string, string> = {}
  if (isRecord(root.formulas)) {
    for (const [k, v] of Object.entries(root.formulas)) if (v !== null && v !== undefined) formulas[k] = String(v)
  }
  const displayNames: Record<string, string> = {}
  if (isRecord(root.properties)) {
    for (const [k, v] of Object.entries(root.properties)) {
      if (isRecord(v) && typeof v.displayName === 'string') displayNames[k] = v.displayName
    }
  }
  const views: BaseView[] = []
  const rawViews = Array.isArray(root.views) ? root.views : []
  rawViews.forEach((raw, k) => {
    if (!isRecord(raw)) return
    const options: Record<string, unknown> = isRecord(raw.options) ? { ...raw.options } : {}
    for (const [key, val] of Object.entries(raw)) if (!VIEW_KEYS.has(key)) options[key] = val
    const view: BaseView = {
      type: String(raw.type ?? 'table'),
      name: String(raw.name ?? `View ${k + 1}`),
      sort: (Array.isArray(raw.sort) ? raw.sort : []).map(asSort).filter((s): s is SortSpec => !!s),
      order: (Array.isArray(raw.order) ? raw.order : []).map(String),
      options,
    }
    const filters = asFilter(raw.filters)
    if (filters) view.filters = filters
    const groupBy = asSort(raw.groupBy)
    if (groupBy) view.groupBy = groupBy
    if (typeof raw.limit === 'number') view.limit = raw.limit
    views.push(view)
  })
  if (!views.length) views.push({ type: 'table', name: 'Table', sort: [], order: [], options: {} })
  const config: BaseConfig = { formulas, displayNames, views }
  const filters = asFilter(root.filters)
  if (filters) config.filters = filters
  return config
}

/** A column's heading: the base's displayName, else the property's own name. */
export function displayName(config: BaseConfig, prop: string): string {
  const named = config.displayNames[prop] ?? config.displayNames[prop.replace(/^note\./, '')] ?? config.displayNames[`note.${prop}`]
  if (named) return named
  if (prop === 'file.name' || prop === 'file.basename') return 'Name'
  return prop.replace(/^(note|formula|file)\./, '')
}

// ── evaluation ───────────────────────────────────────────────────────────

export type Row = {
  file: FileV
  get: (prop: string) => Val
}

export type ViewResult = {
  rows: Row[]
  /** How many files passed the filters before the view's limit. */
  matched: number
  /** Filter parts and properties this evaluator could not read (each skipped, not guessed). */
  warnings: string[]
}

export type EvalContext = Omit<Env, 'file' | 'formulas'>

function makeRow(file: FileV, ev: Evaluator, warn: (msg: string) => void): Row {
  const cache = new Map<string, Val>()
  return {
    file,
    get(prop: string): Val {
      if (cache.has(prop)) return cache.get(prop) ?? null
      let v: Val = null
      try {
        v = ev.eval(prop)
      } catch (err) {
        warn(`${prop}: ${err instanceof Error ? err.message : String(err)}`)
      }
      cache.set(prop, v)
      return v
    },
  }
}

function test(node: FilterNode, row: Row, ev: (expr: string) => boolean): boolean {
  if (typeof node === 'string') return ev(node)
  if ('and' in node) return node.and.every(n => test(n, row, ev))
  if ('or' in node) return node.or.length === 0 || node.or.some(n => test(n, row, ev))
  return !node.not.some(n => test(n, row, ev))
}

/** Bases sort order: empty values last in either direction, then numbers, dates, text. */
export function sortCompare(a: Val, b: Val, direction: 'ASC' | 'DESC' = 'ASC'): number {
  const empty = (v: Val) => v === null || v === '' || (Array.isArray(v) && v.length === 0)
  if (empty(a) && empty(b)) return 0
  if (empty(a)) return 1
  if (empty(b)) return -1
  let c = compare(a, b)
  if (Number.isNaN(c)) {
    const da = typeof a === 'string' ? toDate(a) : null
    const db = typeof b === 'string' ? toDate(b) : null
    c = da && db ? da.ms - db.ms : toText(a).localeCompare(toText(b), undefined, { numeric: true, sensitivity: 'base' })
  }
  return direction === 'DESC' ? -c : c
}

export function evaluateView(config: BaseConfig, view: BaseView, files: FileV[], ctx: EvalContext): ViewResult {
  const warnings = new Set<string>()
  const warn = (msg: string) => warnings.add(msg)
  const filters = [config.filters, view.filters].filter((f): f is FilterNode => !!f)
  const rows: Row[] = []
  for (const file of files) {
    const ev = new Evaluator({ ...ctx, file, formulas: config.formulas })
    const row = makeRow(file, ev, warn)
    const passes = filters.every(f =>
      test(f, row, expr => {
        try {
          const v = ev.eval(expr)
          return v !== null && v !== false && v !== '' && v !== 0 && !(Array.isArray(v) && v.length === 0)
        } catch (err) {
          // Skip what cannot be read (treated as passing) and say so in the pane.
          warn(`filter ${expr}: ${err instanceof Unsupported || err instanceof Error ? err.message : String(err)}`)
          return true
        }
      }),
    )
    if (passes) rows.push(row)
  }
  const specs = view.sort.length ? view.sort : []
  rows.sort((a, b) => {
    for (const spec of specs) {
      const c = sortCompare(a.get(spec.property), b.get(spec.property), spec.direction)
      if (c) return c
    }
    return a.file.basename.localeCompare(b.file.basename, undefined, { numeric: true, sensitivity: 'base' })
  })
  const matched = rows.length
  const limited = view.limit && view.limit > 0 ? rows.slice(0, view.limit) : rows
  return { rows: limited, matched, warnings: [...warnings] }
}

export type Group = {
  key: string
  label: string
  value: Val
  rows: Row[]
}

/**
 * Rows grouped by a property. A list value puts the row in one group per item (a task in
 * two projects shows under both); an empty value goes to "(none)". `order` may give the
 * groups' order (TaskNotes' status order); otherwise values sort by Bases order.
 */
export function groupRows(rows: Row[], spec: SortSpec, order?: (keys: string[]) => string[] | undefined): Group[] {
  const groups = new Map<string, Group>()
  for (const row of rows) {
    const v = row.get(spec.property)
    const items: Val[] = Array.isArray(v) ? (v.length ? v : [null]) : [v]
    for (const item of items) {
      const label = toText(item) || '(none)'
      const key = label.toLowerCase()
      let g = groups.get(key)
      if (!g) {
        g = { key, label, value: item, rows: [] }
        groups.set(key, g)
      }
      if (!g.rows.includes(row)) g.rows.push(row)
    }
  }
  const list = [...groups.values()]
  const custom = order?.(list.map(g => g.key))
  if (custom) {
    const rank = new Map(custom.map((k, i) => [k, i]))
    list.sort((a, b) => (rank.get(a.key) ?? 1e9) - (rank.get(b.key) ?? 1e9) || a.label.localeCompare(b.label))
    if (spec.direction === 'DESC') list.reverse()
    return list
  }
  list.sort((a, b) => sortCompare(a.value, b.value, spec.direction))
  return list
}
