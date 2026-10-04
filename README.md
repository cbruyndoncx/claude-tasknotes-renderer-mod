# claude-tasknotes-renderer-mod

A [Claude Code](https://claude.com/claude-code) mod that shows the tasks of an Obsidian vault that
uses the [TaskNotes](https://github.com/callumalpass/tasknotes) plugin in a side pane of the
**Claude Desktop Code tab**: a kanban board, a grouped list, an agenda of the coming days, or a
dependency graph with the critical path.

It reads the same `.base` files TaskNotes' views are made of (Obsidian Bases), and evaluates
their filters, formulas, sort and grouping itself. A view in Desktop therefore shows the
tasks the same view shows in Obsidian, without Obsidian running.

| Layout | Drawn for | What it shows |
|---|---|---|
| **Board** | `tasknotesKanban` views | Columns by the view's `groupBy` (default: status). Status columns follow TaskNotes' order and colours; empty ones stay unless the view hides them. |
| **List** | `tasknotesTaskList`, `table` and other views | Sections by `groupBy`, rows in the view's sort order. Table views also show their formula columns. |
| **Agenda** | `tasknotesCalendar` and `tasknotesMiniCalendar` views | Overdue tasks first, then the next 7 days (`listDayCount`) by due and scheduled date. Recurring tasks are expanded from their rule, minus completed instances. |
| **Graph** | any view, on request | `blockedBy` arrows laid out in layers. The critical path is the longest chain of unfinished work, by `timeEstimate` or else `size`, drawn in red. Blockers and dependents outside the view are drawn dashed; broken links and cycles are flagged. Finished tasks shrink to a dot; hover it for the card, or hide them with one press. |

Every card shows the properties the view's `order` lists that TaskNotes knows how to show:
status, priority, due (red when overdue), scheduled, projects, contexts, a "blocked by N"
badge, recurrence, assignee and size. It also shows **Done When** checkbox progress when the
note has that section. The ↗ button on a card opens the note in Obsidian.

The pane is read-only: it never writes a task. Claude still edits tasks when you ask, and the
pane redraws after every Write or Edit to a note, the base or TaskNotes' settings.

## Use

The command is `/taskboard`: `/tasks` is Claude Code's own background-tasks command, and
`/tasknotes` is usually taken by a TaskNotes skill.

- `/taskboard`: the file TaskNotes opens for its tasks view.
- `/taskboard kanban` (or `tasks`, `agenda`, `calendar`, `mini-calendar`, `relationships`): the
  `.base` file TaskNotes opens for that command (its `commandFileMapping` setting).
- `/taskboard <file.base> [view name or number] [--board|--list|--agenda|--graph] [--project=A,B] [--context=X]`
- Or just ask Claude ("show my overdue tasks", "show the dependency graph of the kanban").
  The mod registers the model tool `mcp__tasknotes-preview__open` with `base`, `view`,
  `layout`, `project` and `context`. Its answer includes counts per column, so Claude knows what you are looking at.

The toolbar has a view picker, the four layouts (one press each), Refresh and **Open in
Obsidian**. Under it, **pills** for the projects and contexts of the view's tasks (most used
first) narrow every layout. Pills in one row widen each other (any of them), and the two rows
narrow each other (both must hold). **Clear filters** resets them. The graph adds the same controls as
[claude-diagrams-renderer-mod](https://github.com/cbruyndoncx/claude-diagrams-renderer-mod):
a one-press landscape/portrait switch and zoom (− · Fit · +) with ◀ ▶ pan, plus **Hide done /
Show done**.

## Install

This is a *mod*: a plugin of Claude Code function hooks (early access; written against
Claude Code 2.1.286). The plugin is named `tasknotes-preview`.

1. Clone this repository.
2. Add it to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of your **user** settings
   (`~/.claude/settings.json`; project settings cannot set it). Separate several mods with
   `;` on Windows and `:` elsewhere:

   ```json
   { "env": { "CLAUDE_CODE_PLUGIN_DIRS": "\\\\wsl.localhost\\Ubuntu\\home\\you\\projects\\dev\\claude-tasknotes-renderer-mod" } }
   ```

3. Start a new Code-tab session in (or below) your vault folder.

## Requirements

- **Required:** Claude Code with mods (function hooks), 2.1.286 or later. There are no npm
  packages, and the mod installs nothing.
- **Your vault:** TaskNotes' settings (`.obsidian/plugins/tasknotes/data.json`) give the
  folders, statuses, priorities, field mapping and view files. Without them the mod uses
  TaskNotes' defaults.
- **Optional:** the [Advanced URI](https://github.com/Vinzent03/obsidian-advanced-uri) plugin in
  Obsidian, for the ↗ and Open in Obsidian buttons.

## How faithful it is

- **Expressions.** The Bases expression language is implemented, not approximated:
  - operators;
  - `if`, `date`, `today`, `now`, `number`, `list`, `file`, `link`, `min`, `max`, `duration`;
  - date arithmetic with durations (`today() + "7 days"`);
  - list `filter` / `map` / `reduce`;
  - string, number, date, file and link methods;
  - `this`, and formulas that use other formulas.

  Anything it does not know is **skipped and named** under the caption, never guessed.
- **Scope.** Filters run over the notes in TaskNotes' tasks and archive folders, not the whole
  vault, so a base about other notes shows nothing. When a base's own filters leave the archive
  out (`!file.inFolder("…/Archive")`), the archive is not read at all, apart from the archived
  notes that open tasks name as blockers, so a finished blocker still shows as finished. `file.ctime` is the note's `dateCreated`
  (the pane cannot read creation times), and `file.tags` are the frontmatter tags.
- **What a base says is what you get.** TaskNotes' default bases filter on `file.hasTag("task")`.
  If your tasks are identified by a property instead (`type: task`), those views show only
  the tagged tasks, in Obsidian as here. Change the filter to `type == "task"` to see all of
  them, and exclude the archive folder if your archived tasks do not all carry the
  `archived` tag.

## Develop

```bash
claude plugin validate .
claude plugin test .
```

- `hooks/register.tsx`: the hooks module (command, model tool, loading the vault, the pane).
- `hooks/yaml.ts`: a YAML reader for frontmatter and `.base` files.
- `hooks/expr.ts`: the Bases expression language (tokenizer, parser, evaluator).
- `hooks/bases.ts`: `.base` files: views, filters, sort, groups.
- `hooks/tasknotes.ts`: TaskNotes settings and the task model.
- `hooks/model.ts`, `hooks/agenda.ts`, `hooks/graph.ts`: what each layout shows.
- `tests/`: 29 tests run by `claude plugin test`. There is no real filesystem; the tests' hooks
  serve a small vault.

Every hook has a 10-second budget of its own time, and a pane redraws on every press and
resize. So the vault's task model is built once per set of file changes, a view is evaluated
once per day, and each layout's result is kept until something it reads changes.
`tests/perf.test.tsx` holds a 1,600-note vault to those limits.

The engine only follows `$` (the engine interface) inside the hooks module itself, so
everything that reads files lives in `register.tsx`; everything else is pure.

## Credits

The sort order and task-field normalisation follow
[obsidian-bob-workspace](https://github.com/cbruyndoncx/obsidian-bob-workspace) (MIT, same author). TaskNotes is by
Callum Alpass; this mod is not affiliated with it.

## License

[MIT](LICENSE)
