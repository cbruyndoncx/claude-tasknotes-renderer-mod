// A small vault with TaskNotes settings, task notes and .base views, dated relative to today
// so due, overdue and agenda tests hold on any day.

function local(offsetDays: number): Date {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays)
}

/** `YYYY-MM-DD`, `offsetDays` from today. */
export function day(offsetDays: number): string {
  const d = local(offsetDays)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export const ROOT = 'C:\\vault'
export const realOf = (rel: string) => `${ROOT}\\${rel.split('/').join('\\')}`

export const SETTINGS = JSON.stringify({
  tasksFolder: 'TaskNotes/Tasks',
  archiveFolder: 'TaskNotes/Archive',
  excludedFolders: 'Templates',
  taskIdentificationMethod: 'property',
  taskPropertyName: 'type',
  taskPropertyValue: 'task',
  taskTag: 'task',
  customStatuses: [
    { value: 'none', label: 'None', color: '#cccccc', isCompleted: false, order: 0 },
    { value: 'open', label: 'Backlog', color: '#808080', isCompleted: false, order: 1 },
    { value: 'next', label: 'Next', color: '#0d9488', isCompleted: false, order: 2 },
    { value: 'in-progress', label: 'In progress', color: '#0066cc', isCompleted: false, order: 3 },
    { value: 'awaiting-input', label: 'Awaiting Input', color: '#ff8800', isCompleted: false, order: 4 },
    { value: 'done', label: 'Done', color: '#00aa00', isCompleted: true, order: 5 },
    { value: 'cancelled', label: 'Cancelled', color: '#78716c', isCompleted: true, order: 6 },
  ],
  customPriorities: [
    { value: 'none', label: 'None', color: '#cccccc', weight: 0 },
    { value: 'low', label: 'Low', color: '#00aa00', weight: 1 },
    { value: 'normal', label: 'Normal', color: '#ffaa00', weight: 2 },
    { value: 'high', label: 'High', color: '#ff0000', weight: 3 },
  ],
  fieldMapping: { status: 'status', due: 'due', scheduled: 'scheduled', blockedBy: 'blockedBy', completeInstances: 'complete_instances' },
  commandFileMapping: {
    'open-kanban-view': 'TaskNotes/Views/kanban.base',
    'open-tasks-view': 'TaskNotes/Views/tasks.base',
    'open-agenda-view': 'TaskNotes/Views/agenda.base',
  },
})

const compact = (s: string) => s.replace(/-/g, '')

export const TASKS: Record<string, string> = {
  'TaskNotes/Tasks/Design schema.md': `---
title: Design schema
type: task
status: done
priority: high
size: S
tags:
  - task
dateCreated: 2026-09-01T10:00:00.000+02:00
---
Done.
`,
  'TaskNotes/Tasks/Build API.md': `---
title: Build API
type: task
status: in-progress
priority: high
due: ${day(2)}
size: M
projects:
  - '[[Platform]]'
blockedBy:
  - "[[Design schema]]"
assignee: ["agent"]
---
## Done When

- [x] AC1: endpoints exist
  CHECK: test -f api.ts
- [x] AC2: tests pass
- [ ] AC3: docs linked

## Notes
- [ ] not counted
`,
  'TaskNotes/Tasks/Write docs.md': `---
title: Write docs
type: task
status: open
priority: normal
scheduled: '${day(5)}'
size: L
blockedBy:
  - uid: "[[Build API]]"
    reltype: FINISHTOSTART
---
`,
  'TaskNotes/Tasks/Launch.md': `---
title: Launch
type: task
status: next
priority: high
due: ${day(-1)} 09:00:00+02:00
size: XL
blockedBy:
- '[[Write docs]]'
- '[[Build API]]'
---
`,
  'TaskNotes/Tasks/Daily review.md': `---
title: Daily review
type: task
status: next
priority: normal
recurrence: "DTSTART:${compact(day(-3))};daily"
complete_instances:
  - ${day(0)}
---
`,
  'TaskNotes/Tasks/Pay invoice.md': `---
title: Pay invoice
type: task
status: awaiting-input
priority: low
due: ${day(0)}
awaiting: >-
  Waiting for the supplier
  to send the corrected invoice
---
`,
  'TaskNotes/Tasks/Reference note.md': `---
title: Not a task
status: open
---
`,
  'TaskNotes/Archive/Old task.md': `---
title: Old task
type: task
status: done
tags: [task, archived]
---
`,
}

const FORMULAS = `formulas:
  priorityWeight: if(priority=="none",0,if(priority=="low",1,if(priority=="normal",2,if(priority=="high",3,999))))
  daysUntilDue: if(due, ((number(date(due)) - number(today())) / 86400000).floor(), null)
  daysUntilScheduled: if(scheduled, ((number(date(scheduled)) - number(today())) / 86400000).floor(), null)
  daysUntilNext: if(due && scheduled, min(formula.daysUntilDue, formula.daysUntilScheduled), if(due, formula.daysUntilDue, formula.daysUntilScheduled))
  urgencyScore: if(!due && !scheduled, formula.priorityWeight, formula.priorityWeight + max(0, 10 - formula.daysUntilNext))
  dueDateDisplay: if(!due, "", if(date(due).date() == today(), "Today", if(date(due).date() == today() + "1d", "Tomorrow", if(date(due).date() == today() - "1d", "Yesterday", if(date(due) < today(), formula.daysUntilDue * -1 + "d ago", if(date(due) <= today() + "7d", date(due).format("ddd"), date(due).format("MMM D")))))))
`

export const KANBAN_BASE = `filters:
  and:
    - type == "task"
    - '!file.inFolder("TaskNotes/Archive")'
${FORMULAS}views:
  - type: tasknotesKanban
    name: Kanban Board
    groupBy:
      property: status
      direction: ASC
    order:
      - status
      - priority
      - due
      - projects
      - blockedBy
    options:
      columnWidth: 280
      hideEmptyColumns: false
`

const ACTIVE = `        - or:
            - and:
                - '!recurrence'
                - status != "done"
            - and:
                - recurrence
                - '!list(complete_instances).contains(today().format("YYYY-MM-DD"))'
`

export const TASKS_BASE = `filters:
  and:
    - or:
        - file.hasTag("task")
        - type == "task"
    - '!file.hasTag("archived")'
${FORMULAS}views:
  - type: tasknotesTaskList
    name: Not Blocked
    filters:
      and:
${ACTIVE}        - or:
            - blockedBy.isEmpty()
            - list(blockedBy).filter(file(if(value.isType("object"), value.uid, value)).properties.status != "done").isEmpty()
    order:
      - status
      - priority
      - due
    sort:
      - property: formula.urgencyScore
        direction: DESC
  - type: tasknotesTaskList
    name: This Week
    filters:
      and:
${ACTIVE}        - or:
            - and:
                - due && date(due) >= today()
                - due && date(due) <= today() + "7 days"
            - and:
                - scheduled && date(scheduled) >= today()
                - scheduled && date(scheduled) <= today() + "7 days"
    sort:
      - property: formula.urgencyScore
        direction: DESC
  - type: table
    name: TableView
    groupBy:
      property: status
      direction: ASC
    order:
      - title
      - status
      - size
      - formula.urgencyScore
    sort:
      - property: size
        direction: ASC
  - type: tasknotesTaskList
    name: Odd
    filters:
      and:
        - file.backlinks.length > 0
`

export const AGENDA_BASE = `filters:
  and:
    - type == "task"
views:
  - type: tasknotesCalendar
    name: Agenda
    calendarView: listWeek
    listDayCount: 7
`

export const FILES: Record<string, string> = {
  '.obsidian/plugins/tasknotes/data.json': SETTINGS,
  'TaskNotes/Views/kanban.base': KANBAN_BASE,
  'TaskNotes/Views/tasks.base': TASKS_BASE,
  'TaskNotes/Views/agenda.base': AGENDA_BASE,
  ...TASKS,
}
