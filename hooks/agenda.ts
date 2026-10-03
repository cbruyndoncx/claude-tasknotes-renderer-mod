// The agenda: overdue tasks, then the next N days by due and scheduled date, with recurring
// tasks expanded from their recurrence rule (TaskNotes writes `DTSTART:20260406;monthly`
// as well as RFC 5545 `FREQ=MONTHLY;INTERVAL=3`). Instances already completed are left out.

import { formatDate, toDate } from './expr'
import type { Task } from './tasknotes'

const DAY = 86400000
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

export type Rule = {
  start: number
  freq: 'daily' | 'weekly' | 'monthly' | 'yearly'
  interval: number
  byDay?: number[]
  byMonthDay?: number[]
  until?: number
}

export function midnight(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** Whole calendar days from `a` to `b` (both local), robust to DST changes. */
function daysBetween(a: number, b: number): number {
  return Math.round((midnight(b) - midnight(a)) / DAY)
}

export function parseRecurrence(text: string, fallbackStart?: number): Rule | undefined {
  let start = fallbackStart
  let freq: Rule['freq'] | undefined
  let interval = 1
  let byDay: number[] | undefined
  let byMonthDay: number[] | undefined
  let until: number | undefined
  for (const rawPart of text.replace(/^RRULE:/i, '').split(/[;\n]/)) {
    const part = rawPart.trim().replace(/^RRULE:/i, '')
    if (!part) continue
    const dt = /^DTSTART(?:;[^:]*)?:(\d{8})/i.exec(part)
    if (dt) {
      start = toDate(dt[1] ?? '')?.ms ?? start
      continue
    }
    const kv = /^([A-Z]+)=(.*)$/i.exec(part)
    if (kv) {
      const key = (kv[1] ?? '').toUpperCase()
      const val = (kv[2] ?? '').trim()
      if (key === 'FREQ') freq = val.toLowerCase() as Rule['freq']
      else if (key === 'INTERVAL') interval = Math.max(1, Number(val) || 1)
      else if (key === 'BYDAY') byDay = val.split(',').map(d => WEEKDAYS.indexOf(d.replace(/^[-+\d]+/, '').toUpperCase())).filter(d => d >= 0)
      else if (key === 'BYMONTHDAY') byMonthDay = val.split(',').map(Number).filter(n => Number.isFinite(n) && n !== 0)
      else if (key === 'UNTIL') until = toDate(val.slice(0, 8))?.ms
      continue
    }
    const word = part.toLowerCase()
    if (word === 'daily' || word === 'weekly' || word === 'monthly' || word === 'yearly') freq = word
  }
  if (!freq || !['daily', 'weekly', 'monthly', 'yearly'].includes(freq) || start === undefined) return undefined
  const rule: Rule = { start: midnight(start), freq, interval }
  if (byDay?.length) rule.byDay = byDay
  if (byMonthDay?.length) rule.byMonthDay = byMonthDay
  if (until !== undefined) rule.until = until
  return rule
}

export function occursOn(rule: Rule, day: number): boolean {
  const d = midnight(day)
  if (d < rule.start || (rule.until !== undefined && d > rule.until)) return false
  const date = new Date(d)
  const first = new Date(rule.start)
  switch (rule.freq) {
    case 'daily':
      return daysBetween(rule.start, d) % rule.interval === 0
    case 'weekly': {
      const days = rule.byDay ?? [first.getDay()]
      if (!days.includes(date.getDay())) return false
      const weekStart = (ms: number) => midnight(ms) - new Date(ms).getDay() * DAY
      const weeks = Math.round((weekStart(d) - weekStart(rule.start)) / (7 * DAY))
      return weeks % rule.interval === 0
    }
    case 'monthly': {
      const months = (date.getFullYear() - first.getFullYear()) * 12 + date.getMonth() - first.getMonth()
      if (months % rule.interval !== 0) return false
      const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
      const wanted = (rule.byMonthDay ?? [first.getDate()]).map(n => (n < 0 ? lastDay + 1 + n : Math.min(n, lastDay)))
      return wanted.includes(date.getDate())
    }
    case 'yearly':
      return (date.getFullYear() - first.getFullYear()) % rule.interval === 0 &&
        date.getMonth() === first.getMonth() && date.getDate() === first.getDate()
  }
}

export type AgendaItem = { task: Task; kind: 'due' | 'scheduled' | 'recurring'; date: number }
export type AgendaDay = { date: number; items: AgendaItem[] }
export type Agenda = { overdue: AgendaItem[]; days: AgendaDay[] }

function weightOf(task: Task): number {
  return task.priorityDef?.weight ?? 0
}

export function buildAgenda(tasks: Task[], now: number, dayCount: number): Agenda {
  const today = midnight(now)
  const count = Math.max(1, Math.min(31, Math.floor(dayCount) || 7))
  const days: AgendaDay[] = Array.from({ length: count }, (_, k) => {
    const d = new Date(today)
    d.setDate(d.getDate() + k)
    return { date: d.getTime(), items: [] }
  })
  const overdue: AgendaItem[] = []
  for (const task of tasks) {
    if (task.done) continue
    if (task.recurrence) {
      const fallback = task.scheduled?.ms ?? task.due?.ms ?? toDate(task.file.properties.dateCreated)?.ms ?? task.file.ctime
      const rule = parseRecurrence(task.recurrence, fallback)
      if (rule) {
        for (const day of days) {
          if (occursOn(rule, day.date) && !task.completeInstances.includes(formatDate(day.date, 'YYYY-MM-DD'))) {
            day.items.push({ task, kind: 'recurring', date: day.date })
          }
        }
        continue
      }
    }
    const due = task.due ? midnight(task.due.ms) : undefined
    const scheduled = task.scheduled ? midnight(task.scheduled.ms) : undefined
    if (due !== undefined && due < today) {
      overdue.push({ task, kind: 'due', date: due })
      continue
    }
    if (due === undefined && scheduled !== undefined && scheduled < today) {
      overdue.push({ task, kind: 'scheduled', date: scheduled })
      continue
    }
    for (const day of days) {
      if (due === day.date) day.items.push({ task, kind: 'due', date: day.date })
      else if (scheduled === day.date) day.items.push({ task, kind: 'scheduled', date: day.date })
    }
  }
  const order = (a: AgendaItem, b: AgendaItem) => weightOf(b.task) - weightOf(a.task) || a.task.title.localeCompare(b.task.title)
  overdue.sort((a, b) => a.date - b.date || order(a, b))
  for (const day of days) day.items.sort(order)
  return { overdue, days }
}

export function dayLabel(date: number, now: number): string {
  const diff = daysBetween(now, date)
  const name = formatDate(date, 'ddd D MMM')
  if (diff === 0) return `Today · ${name}`
  if (diff === 1) return `Tomorrow · ${name}`
  return name
}
