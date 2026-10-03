// The dependency graph: blockedBy arrows between tasks, laid out in layers (a task sits one
// layer after its latest blocker), with the critical path, the longest chain of unfinished
// work by duration, drawn in red. Landscape runs left to right, portrait top to bottom.

import { CHAR_WIDTH, esc, wrapLines } from './common'
import type { Orientation } from './common'
import { durationDays, findTask, taskIndex } from './tasknotes'
import type { Task, TaskNotesSettings } from './tasknotes'
import { linkKey } from './expr'

export type GraphNode = {
  key: string
  title: string
  task?: Task
  /** In the view (false: a blocker or dependent outside it, drawn dashed as context). */
  inView: boolean
  /** A blockedBy link that names no task. */
  missing: boolean
  level: number
  order: number
  critical: boolean
  cycle: boolean
  days: number
}

export type GraphEdge = { from: string; to: string; critical: boolean }

export type Graph = {
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** View tasks with no blockedBy relation, left out of the drawing. */
  isolated: number
  /** Days of unfinished work on the critical path (0 when there is no chain). */
  criticalDays: number
  cycles: number
}

export function buildGraph(viewTasks: Task[], allTasks: Task[]): Graph {
  const index = taskIndex(allTasks)
  const nodes = new Map<string, GraphNode>()
  const edges: GraphEdge[] = []
  const viewKeys = new Set(viewTasks.map(t => linkKey(t.file)))
  const node = (key: string, task: Task | undefined, title: string): GraphNode => {
    let n = nodes.get(key)
    if (!n) {
      n = { key, title, inView: viewKeys.has(key), missing: !task, level: 0, order: 0, critical: false, cycle: false, days: task ? durationDays(task) : 0 }
      if (task) n.task = task
      nodes.set(key, n)
    }
    return n
  }
  const addEdge = (from: string, to: string) => {
    if (from !== to && !edges.some(e => e.from === from && e.to === to)) edges.push({ from, to, critical: false })
  }
  for (const task of viewTasks) {
    const key = linkKey(task.file)
    for (const target of task.blockedBy) {
      const blocker = findTask(index, target)
      const bkey = blocker ? linkKey(blocker.file) : `missing:${linkKey(target)}`
      node(key, task, task.title)
      node(bkey, blocker, blocker ? blocker.title : target)
      addEdge(bkey, key)
    }
  }
  // Dependents outside the view, one hop, as context.
  for (const task of allTasks) {
    const key = linkKey(task.file)
    if (viewKeys.has(key)) continue
    for (const target of task.blockedBy) {
      const blocker = findTask(index, target)
      if (blocker && viewKeys.has(linkKey(blocker.file))) {
        node(linkKey(blocker.file), blocker, blocker.title)
        node(key, task, task.title)
        addEdge(linkKey(blocker.file), key)
      }
    }
  }

  // Layers: Kahn's order; what is left is in a cycle.
  const preds = new Map<string, string[]>()
  const succs = new Map<string, string[]>()
  for (const n of nodes.keys()) {
    preds.set(n, [])
    succs.set(n, [])
  }
  for (const e of edges) {
    preds.get(e.to)?.push(e.from)
    succs.get(e.from)?.push(e.to)
  }
  const indeg = new Map([...nodes.keys()].map(k => [k, preds.get(k)?.length ?? 0]))
  const queue = [...nodes.keys()].filter(k => indeg.get(k) === 0)
  const topo: string[] = []
  while (queue.length) {
    const k = queue.shift() as string
    topo.push(k)
    for (const s of succs.get(k) ?? []) {
      const d = (indeg.get(s) ?? 0) - 1
      indeg.set(s, d)
      if (d === 0) queue.push(s)
    }
  }
  for (const k of topo) {
    const n = nodes.get(k) as GraphNode
    n.level = Math.max(0, ...(preds.get(k) ?? []).map(p => (nodes.get(p)?.level ?? 0) + 1))
  }
  const inCycle = [...nodes.keys()].filter(k => !topo.includes(k))
  const maxLevel = Math.max(0, ...[...nodes.values()].map(n => n.level))
  for (const k of inCycle) {
    const n = nodes.get(k) as GraphNode
    n.cycle = true
    n.level = maxLevel + 1
  }

  // Critical path over unfinished work.
  const dist = new Map<string, number>()
  const via = new Map<string, string>()
  for (const k of topo) {
    const n = nodes.get(k) as GraphNode
    const own = n.task && !n.task.done ? n.days : 0
    let best = 0
    for (const p of preds.get(k) ?? []) {
      const d = dist.get(p) ?? 0
      if (d > best) {
        best = d
        via.set(k, p)
      }
    }
    dist.set(k, best + own)
  }
  let end: string | undefined
  for (const [k, d] of dist) if (end === undefined || d > (dist.get(end) ?? 0)) end = k
  let criticalDays = 0
  if (end && via.has(end)) {
    criticalDays = dist.get(end) ?? 0
    for (let k: string | undefined = end; k; k = via.get(k)) {
      const n = nodes.get(k) as GraphNode
      if (n.task?.done) break
      n.critical = true
      const p = via.get(k)
      const e = p ? edges.find(x => x.from === p && x.to === k) : undefined
      if (e && !nodes.get(p as string)?.task?.done) e.critical = true
    }
  }

  // Order within layers: barycentre sweeps to cut crossings.
  const levels = new Map<number, GraphNode[]>()
  for (const n of nodes.values()) levels.set(n.level, [...(levels.get(n.level) ?? []), n])
  for (const list of levels.values()) list.sort((a, b) => a.title.localeCompare(b.title)).forEach((n, i) => (n.order = i))
  const sorted = [...levels.keys()].sort((a, b) => a - b)
  for (let sweep = 0; sweep < 4; sweep++) {
    const pass = sweep % 2 === 0 ? sorted : [...sorted].reverse()
    for (const lv of pass) {
      const list = levels.get(lv) ?? []
      const centre = (n: GraphNode) => {
        const near = (sweep % 2 === 0 ? preds : succs).get(n.key) ?? []
        if (!near.length) return n.order
        return near.reduce((s, k) => s + (nodes.get(k)?.order ?? 0), 0) / near.length
      }
      list.sort((a, b) => centre(a) - centre(b) || a.order - b.order).forEach((n, i) => (n.order = i))
    }
  }

  const related = new Set(edges.flatMap(e => [e.from, e.to]))
  const isolated = viewTasks.filter(t => !related.has(linkKey(t.file))).length
  return { nodes: [...nodes.values()], edges, isolated, criticalDays, cycles: inCycle.length }
}

// ── drawing ──────────────────────────────────────────────────────────────

const W = 230
const H = 66
const FONT = 12
const CRITICAL = '#d62728'

export function graphSvg(graph: Graph, settings: TaskNotesSettings, orientation: Orientation): string {
  const landscape = orientation === 'landscape'
  const pad = 20
  const along = landscape ? W + 80 : H + 56 // distance between layers
  const across = landscape ? H + 22 : W + 22 // distance between siblings
  const pos = new Map<string, { x: number; y: number }>()
  for (const n of graph.nodes) {
    const a = n.level * along
    const b = n.order * across
    pos.set(n.key, landscape ? { x: pad + a, y: pad + b } : { x: pad + b, y: pad + a })
  }
  const width = Math.max(W, ...[...pos.values()].map(p => p.x + W)) + pad
  const height = Math.max(H, ...[...pos.values()].map(p => p.y + H)) + pad
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Segoe UI, Helvetica, Arial, sans-serif">`,
    '<defs>',
    '<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#888"/></marker>',
    `<marker id="arrow-critical" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${CRITICAL}"/></marker>`,
    '</defs>',
    `<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>`,
  ]
  const order = [...graph.edges].sort((a, b) => Number(a.critical) - Number(b.critical))
  for (const e of order) {
    const from = pos.get(e.from)
    const to = pos.get(e.to)
    if (!from || !to) continue
    const [x1, y1, x2, y2] = landscape
      ? [from.x + W, from.y + H / 2, to.x, to.y + H / 2]
      : [from.x + W / 2, from.y + H, to.x + W / 2, to.y]
    const bend = landscape ? Math.max(30, (x2 - x1) / 2) : Math.max(24, (y2 - y1) / 2)
    const d = landscape
      ? `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`
      : `M${x1},${y1} C${x1},${y1 + bend} ${x2},${y2 - bend} ${x2},${y2}`
    const color = e.critical ? CRITICAL : '#9a9a9a'
    parts.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="${e.critical ? 2.5 : 1.4}" marker-end="url(#${e.critical ? 'arrow-critical' : 'arrow'})"/>`)
  }
  const maxChars = Math.floor((W - 22) / (FONT * CHAR_WIDTH))
  for (const n of graph.nodes) {
    const p = pos.get(n.key)
    if (!p) continue
    const status = n.task?.status ?? ''
    const color = n.missing ? '#d62728' : settings.statuses.find(s => s.value.toLowerCase() === status.toLowerCase())?.color ?? '#808080'
    const done = !!n.task?.done
    const stroke = n.critical ? CRITICAL : n.missing ? '#d62728' : n.inView ? '#b8b8b8' : '#c8c8c8'
    const dash = n.inView && !n.missing ? '' : ' stroke-dasharray="5 4"'
    parts.push(`<g${done ? ' opacity="0.55"' : ''}>`)
    parts.push(`<rect x="${p.x}" y="${p.y}" width="${W}" height="${H}" rx="7" fill="${n.inView ? '#ffffff' : '#f6f6f6'}" stroke="${stroke}" stroke-width="${n.critical ? 2.5 : 1.2}"${dash}/>`)
    parts.push(`<rect x="${p.x}" y="${p.y}" width="6" height="${H}" rx="3" fill="${esc(color)}"/>`)
    const title = n.missing ? `not found: ${n.title}` : n.title
    const lines = wrapLines(title, maxChars)
    const shown = lines.slice(0, 2)
    if (lines.length > 2) shown[1] = `${(shown[1] ?? '').slice(0, Math.max(0, maxChars - 1))}…`
    shown.forEach((line, i) => {
      parts.push(`<text x="${p.x + 14}" y="${p.y + 19 + i * 15}" font-size="${FONT}" fill="#1f1f1f"${done ? ' text-decoration="line-through"' : ''}>${esc(line)}</text>`)
    })
    const meta = n.missing
      ? 'blockedBy link with no task'
      : [n.task?.statusDef?.label ?? status, n.task?.size, n.task && !done ? `${Math.round(n.days * 10) / 10}d` : '', n.inView ? '' : 'outside view', n.cycle ? 'in a cycle' : '']
          .filter(Boolean)
          .join(' · ')
    parts.push(`<text x="${p.x + 14}" y="${p.y + H - 10}" font-size="10" fill="${n.cycle ? CRITICAL : '#666666'}">${esc(meta)}</text>`)
    parts.push('</g>')
  }
  parts.push('</svg>')
  return parts.join('')
}
