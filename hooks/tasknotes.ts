// TaskNotes: its settings (data.json) and a task as the panes draw it. Field names go
// through TaskNotes' field mapping, so a vault that renamed `due` to `deadline` still works.
// The field normalisation follows bob-workspace's task-notes.ts (same author, MIT).

import { DateV, FileV, LinkV, linkKey, toDate, toText, wrap } from './expr'
import { isRecord } from './yaml'

export type StatusDef = { value: string; label: string; color: string; isCompleted: boolean; order: number }
export type PriorityDef = { value: string; label: string; color: string; weight: number }

export type TaskNotesSettings = {
  /** False when the vault has no TaskNotes data.json (defaults are used). */
  found: boolean
  tasksFolder: string
  archiveFolder: string
  excludedFolders: string[]
  identify: { method: 'property' | 'tag'; property: string; value: string; tag: string }
  statuses: StatusDef[]
  priorities: PriorityDef[]
  fieldMapping: Record<string, string>
  /** TaskNotes command id (`open-kanban-view`, …) → the .base file it opens. */
  viewFiles: Record<string, string>
}

const DEFAULT_STATUSES: StatusDef[] = [
  { value: 'open', label: 'Open', color: '#808080', isCompleted: false, order: 1 },
  { value: 'in-progress', label: 'In progress', color: '#0066cc', isCompleted: false, order: 2 },
  { value: 'done', label: 'Done', color: '#00aa00', isCompleted: true, order: 3 },
]

const DEFAULT_PRIORITIES: PriorityDef[] = [
  { value: 'low', label: 'Low', color: '#00aa00', weight: 1 },
  { value: 'normal', label: 'Normal', color: '#ffaa00', weight: 2 },
  { value: 'high', label: 'High', color: '#ff0000', weight: 3 },
]

const DEFAULT_VIEW_FILES: Record<string, string> = {
  'open-kanban-view': 'TaskNotes/Views/kanban-default.base',
  'open-tasks-view': 'TaskNotes/Views/tasks-default.base',
  'open-agenda-view': 'TaskNotes/Views/agenda-default.base',
  'open-advanced-calendar-view': 'TaskNotes/Views/calendar-default.base',
  'open-calendar-view': 'TaskNotes/Views/mini-calendar-default.base',
  relationships: 'TaskNotes/Views/relationships.base',
}

/** Short names for `/taskboard <name>`, each a TaskNotes command whose base file it opens. */
export const VIEW_ALIASES: Record<string, string> = {
  kanban: 'open-kanban-view',
  board: 'open-kanban-view',
  tasks: 'open-tasks-view',
  list: 'open-tasks-view',
  agenda: 'open-agenda-view',
  calendar: 'open-advanced-calendar-view',
  'mini-calendar': 'open-calendar-view',
  relationships: 'relationships',
}

const str = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() ? v.trim() : fallback)

export function parseSettings(json: string | undefined): TaskNotesSettings {
  let data: Record<string, unknown> = {}
  let found = false
  if (json) {
    try {
      const parsed: unknown = JSON.parse(json)
      if (isRecord(parsed)) {
        data = parsed
        found = true
      }
    } catch {
      // A broken data.json reads as defaults.
    }
  }
  const statuses = Array.isArray(data.customStatuses)
    ? data.customStatuses.filter(isRecord).map((s, k) => ({
        value: str(s.value, `status-${k}`),
        label: str(s.label, str(s.value, `Status ${k}`)),
        color: str(s.color, '#808080'),
        isCompleted: s.isCompleted === true,
        order: typeof s.order === 'number' ? s.order : k,
      }))
    : DEFAULT_STATUSES
  const priorities = Array.isArray(data.customPriorities)
    ? data.customPriorities.filter(isRecord).map((p, k) => ({
        value: str(p.value, `priority-${k}`),
        label: str(p.label, str(p.value, `Priority ${k}`)),
        color: str(p.color, '#808080'),
        weight: typeof p.weight === 'number' ? p.weight : k,
      }))
    : DEFAULT_PRIORITIES
  const fieldMapping: Record<string, string> = {}
  if (isRecord(data.fieldMapping)) {
    for (const [k, v] of Object.entries(data.fieldMapping)) if (typeof v === 'string' && v) fieldMapping[k] = v
  }
  const viewFiles: Record<string, string> = { ...DEFAULT_VIEW_FILES }
  if (isRecord(data.commandFileMapping)) {
    for (const [k, v] of Object.entries(data.commandFileMapping)) if (typeof v === 'string' && v) viewFiles[k] = v
  }
  const excluded = data.excludedFolders
  return {
    found,
    tasksFolder: str(data.tasksFolder, 'TaskNotes/Tasks').replace(/\/+$/, ''),
    archiveFolder: str(data.archiveFolder, 'TaskNotes/Archive').replace(/\/+$/, ''),
    excludedFolders: (Array.isArray(excluded) ? excluded.map(String) : typeof excluded === 'string' ? excluded.split(',') : [])
      .map(s => s.trim().replace(/\/+$/, ''))
      .filter(Boolean),
    identify: {
      method: data.taskIdentificationMethod === 'property' ? 'property' : 'tag',
      property: str(data.taskPropertyName, 'type'),
      value: str(data.taskPropertyValue, 'task'),
      tag: str(data.taskTag, 'task').replace(/^#/, ''),
    },
    statuses: [...statuses].sort((a, b) => a.order - b.order),
    priorities: [...priorities].sort((a, b) => b.weight - a.weight),
    fieldMapping,
    viewFiles,
  }
}

/** The frontmatter key TaskNotes stores a field under. */
export function fieldKey(settings: TaskNotesSettings, field: string): string {
  return settings.fieldMapping[field] ?? field
}

export function isTaskFile(file: FileV, settings: TaskNotesSettings): boolean {
  if (settings.excludedFolders.some(f => file.path.toLowerCase().startsWith(`${f.toLowerCase()}/`))) return false
  const { method, property, value, tag } = settings.identify
  if (method === 'tag') return file.tags.some(t => t.toLowerCase() === tag.toLowerCase() || t.toLowerCase().startsWith(`${tag.toLowerCase()}/`))
  const raw = file.properties[property]
  const values = Array.isArray(raw) ? raw : [raw]
  return values.some(v => typeof v === 'string' && v.toLowerCase() === value.toLowerCase())
}

// ── a task ───────────────────────────────────────────────────────────────

export type Progress = { done: number; total: number }

export type Task = {
  file: FileV
  title: string
  status: string
  statusDef?: StatusDef
  done: boolean
  priority: string
  priorityDef?: PriorityDef
  due: DateV | null
  scheduled: DateV | null
  completed: DateV | null
  projects: string[]
  contexts: string[]
  /** Link targets of the tasks this one waits for. */
  blockedBy: string[]
  recurrence?: string
  completeInstances: string[]
  size?: string
  estimateMinutes?: number
  assignee: string[]
  /** `## Done When` checkboxes; `## Ready When` ones. */
  doneWhen?: Progress
  readyWhen?: Progress
  awaiting?: string
}

function list(v: unknown): unknown[] {
  if (v === null || v === undefined || v === '') return []
  if (Array.isArray(v)) return v
  if (typeof v === 'string' && v.includes(',') && !v.includes('[[')) return v.split(',').map(s => s.trim()).filter(Boolean)
  return [v]
}

function names(v: unknown): string[] {
  return list(v)
    .map(item => {
      const w = wrap(item)
      return w instanceof LinkV ? w.display || w.target : toText(w)
    })
    .filter(Boolean)
}

/** A blockedBy entry is a wikilink, or `{ uid: wikilink, reltype }`. */
export function blockerTargets(v: unknown): string[] {
  return list(v)
    .map(item => {
      const raw = isRecord(item) ? item.uid : item
      const w = wrap(raw)
      return w instanceof LinkV ? w.target : typeof w === 'string' ? w : ''
    })
    .filter(Boolean)
}

/** Checkbox counts under the first heading named like one of `titles`. */
export function sectionProgress(body: string, titles: string[]): Progress | undefined {
  const lines = body.split(/\r?\n/)
  const want = titles.map(t => t.toLowerCase())
  let level = 0
  let inSection = false
  let done = 0
  let total = 0
  let fence = false
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    if (fence) continue
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (h) {
      const depth = (h[1] ?? '').length
      if (inSection && depth <= level) break
      if (!inSection && want.includes((h[2] ?? '').toLowerCase())) {
        inSection = true
        level = depth
      }
      continue
    }
    if (!inSection) continue
    const box = /^\s*[-*+]\s+\[(.)\]/.exec(line)
    if (box) {
      total++
      if ((box[1] ?? ' ') !== ' ') done++
    }
  }
  return inSection && total > 0 ? { done, total } : undefined
}

export function toTask(file: FileV, body: string, settings: TaskNotesSettings): Task {
  const p = file.properties
  const get = (field: string) => p[fieldKey(settings, field)]
  const status = toText(wrap(get('status'))).trim() || 'none'
  const priority = toText(wrap(get('priority'))).trim() || 'none'
  const statusDef = settings.statuses.find(s => s.value.toLowerCase() === status.toLowerCase())
  const priorityDef = settings.priorities.find(s => s.value.toLowerCase() === priority.toLowerCase())
  const title = toText(wrap(get('title'))).trim() || file.basename
  const estimate = Number(get('timeEstimate'))
  const task: Task = {
    file,
    title,
    status,
    done: statusDef ? statusDef.isCompleted : /^(done|completed|cancel+ed|archived)$/i.test(status),
    priority,
    due: toDate(get('due')),
    scheduled: toDate(get('scheduled')),
    completed: toDate(get('completedDate')),
    projects: names(get('projects')),
    contexts: names(get('contexts')),
    blockedBy: blockerTargets(get('blockedBy')),
    completeInstances: list(get('completeInstances')).map(v => toText(wrap(v))).filter(Boolean),
    assignee: names(p.assignee),
  }
  if (statusDef) task.statusDef = statusDef
  if (priorityDef) task.priorityDef = priorityDef
  const recurrence = toText(wrap(get('recurrence'))).trim()
  if (recurrence) task.recurrence = recurrence
  const size = toText(wrap(p.size)).trim()
  if (size) task.size = size
  if (Number.isFinite(estimate) && estimate > 0) task.estimateMinutes = estimate
  const doneWhen = sectionProgress(body, ['Done When', 'Acceptance Criteria'])
  if (doneWhen) task.doneWhen = doneWhen
  const readyWhen = sectionProgress(body, ['Ready When'])
  if (readyWhen) task.readyWhen = readyWhen
  const awaiting = toText(wrap(p.awaiting)).trim()
  if (awaiting) task.awaiting = awaiting
  return task
}

export function statusLabel(settings: TaskNotesSettings, value: string): string {
  return settings.statuses.find(s => s.value.toLowerCase() === value.toLowerCase())?.label ?? value
}

export function statusColor(settings: TaskNotesSettings, value: string): string | undefined {
  return settings.statuses.find(s => s.value.toLowerCase() === value.toLowerCase())?.color
}

/** Group keys in TaskNotes' status order (unknown values after them). */
export function statusOrder(settings: TaskNotesSettings, keys: string[]): string[] {
  const rank = (k: string) => {
    const i = settings.statuses.findIndex(s => s.value.toLowerCase() === k)
    return i < 0 ? settings.statuses.length : i
  }
  return [...keys].sort((a, b) => rank(a) - rank(b))
}

/** Group keys by priority weight, highest first. */
export function priorityOrder(settings: TaskNotesSettings, keys: string[]): string[] {
  const weight = (k: string) => settings.priorities.find(p => p.value.toLowerCase() === k)?.weight ?? -1
  return [...keys].sort((a, b) => weight(b) - weight(a))
}

const SIZE_DAYS: Record<string, number> = { xs: 0.5, s: 1, m: 2, l: 4, xl: 8 }

/** A task's duration in days for the critical path: timeEstimate (minutes, 8h days), else size, else 1. */
export function durationDays(task: Task): number {
  if (task.estimateMinutes) return task.estimateMinutes / 480
  const bySize = task.size ? SIZE_DAYS[task.size.toLowerCase()] : undefined
  return bySize ?? 1
}

/** Index tasks by link identity (note name), for resolving blockedBy. */
export function taskIndex(tasks: Task[]): Map<string, Task> {
  const index = new Map<string, Task>()
  for (const t of tasks) {
    index.set(linkKey(t.file), t)
    index.set(t.file.path.replace(/\.md$/i, '').toLowerCase(), t)
  }
  return index
}

export function findTask(index: Map<string, Task>, target: string): Task | undefined {
  const clean = target.replace(/\\/g, '/').replace(/\.md$/i, '').toLowerCase()
  return index.get(clean) ?? index.get(linkKey(target))
}
