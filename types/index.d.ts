export type Layout = 'board' | 'list' | 'agenda' | 'graph'

export type TasksTarget = {
  /** The .base file, vault-relative with forward slashes. */
  rel: string
  /** The .base file, resolved absolute path. */
  real: string
  /** Obsidian vault name. */
  vault?: string
  /** The vault folder (holds `.obsidian`), absolute. */
  root: string
  /** Which of the base's views is shown, 0-based. */
  view: number
  /** How it is drawn; absent means the view's own type (kanban → board, calendar → agenda, else list). */
  layout?: Layout
  /** Groups shown in full instead of their first cards, as `<layout>:<group key>`. */
  expanded: string[]
  /** Pill filters on top of the view: a task in any selected project, AND any selected context. */
  projects?: string[]
  contexts?: string[]
  /** Every pill shown, instead of the most used ones. */
  allPills?: boolean
  /** Dependency graph: leave finished tasks out (else they are drawn as dots). */
  hideDone?: boolean
  /** Dependency graph only. */
  orientation: 'landscape' | 'portrait'
  zoom: number
  pan: number
  /** Bumped on every refresh so the pane redraws. */
  rev: number
}

declare module 'claude-code' {
  interface PluginState {
    'tasknotes-preview': { target: StateFamily<TasksTarget> }
  }
}
