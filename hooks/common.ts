// Pure helpers (no `$` here: the engine only follows `$` within the hooks module itself).
// Paths, the Obsidian URI, and the zoom/orientation helpers shared with
// claude-diagrams-renderer-mod, so the dependency graph has the same controls.

/** SvgProps.source is bounded at this many characters. */
export const SVG_LIMIT = 131072

/** Approximate glyph width of a sans-serif font, for wrapping without a layout engine. */
export const CHAR_WIDTH = 0.56

export type Target = {
  /** Vault-relative path with forward slashes (what Obsidian's URI wants). */
  rel: string
  /** Resolved absolute path on this machine. */
  real: string
  /** Obsidian vault name (the vault folder's name); absent outside a vault. */
  vault?: string
}

export function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Greedy word wrap to at most `maxChars` per line; long words are cut. */
export function wrapLines(text: string, maxChars: number): string[] {
  const width = Math.max(4, Math.floor(maxChars))
  const out: string[] = []
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    let line = ''
    for (const word of raw.split(/\s+/).filter(Boolean)) {
      let piece = word
      while (piece.length > width) {
        if (line) {
          out.push(line)
          line = ''
        }
        out.push(piece.slice(0, width))
        piece = piece.slice(width)
      }
      if (!line) line = piece
      else if (line.length + 1 + piece.length <= width) line += ' ' + piece
      else {
        out.push(line)
        line = piece
      }
    }
    out.push(line)
  }
  return out
}

export function sepOf(path: string): string {
  return path.includes('\\') ? '\\' : '/'
}

/** The folder above `path`, or undefined at a drive or filesystem root. */
export function parentOf(path: string): string | undefined {
  const trimmed = path.replace(/[\\/]+$/, '')
  const cut = trimmed.lastIndexOf(sepOf(trimmed))
  if (cut <= 0) return undefined
  const parent = trimmed.slice(0, cut)
  return /^[A-Za-z]:$/.test(parent) ? undefined : parent
}

export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

/** Whether `path` is `folder` or inside it (any separator, any case). */
export function isInside(path: string, folder: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const p = norm(path)
  const f = norm(folder)
  return p === f || p.startsWith(`${f}/`)
}

/** Strip surrounding quotes and a leading "./" from a typed argument. */
export function cleanArg(arg: string): string {
  return arg.trim().replace(/^["']|["']$/g, '').replace(/^\.[\\/]/, '')
}

/** Join a vault root and a vault-relative path with the root's separator. */
export function joinPath(root: string, rel: string): string {
  const sep = sepOf(root)
  return `${root.replace(/[\\/]+$/, '')}${sep}${rel.replace(/^[\\/]+/, '').split(/[\\/]/).join(sep)}`
}

/** A Target for `real` inside the vault rooted at `root`. */
export function targetIn(root: string, real: string): Target {
  const sep = sepOf(real)
  return {
    rel: real.slice(root.length + 1).split(sep).join('/'),
    real,
    vault: root.slice(root.lastIndexOf(sep) + 1),
  }
}

export function obsidianUri(target: Target): string | undefined {
  if (!target.vault) return undefined
  return `obsidian://adv-uri?vault=${encodeURIComponent(target.vault)}` +
    `&filepath=${encodeURIComponent(target.rel)}&openmode=tab`
}

/**
 * Ways to hand an obsidian:// URI to the OS, tried in order. A `Link` element only
 * takes https:, so the URI goes through a process: rundll32's URL handler on Windows
 * (no shell, so the `&` in the URI is safe), `open` on macOS, `xdg-open` elsewhere.
 */
export function launchers(uri: string): string[][] {
  return [
    ['rundll32.exe', 'url.dll,FileProtocolHandler', uri],
    ['open', uri],
    ['xdg-open', uri],
  ]
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ── zoom ─────────────────────────────────────────────────────────────────
// The pane always draws an Svg at its own width, so zoom changes which part of the drawing
// the image shows: above 1 a slice of the width, panned left/right; below 1 a wider view.

export const ZOOM_LEVELS = [0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8] as const

export function stepZoom(current: number, direction: 1 | -1): number {
  const from = current > 0 ? current : 1
  const next = direction > 0
    ? ZOOM_LEVELS.find(z => z > from * 1.01)
    : [...ZOOM_LEVELS].reverse().find(z => z < from * 0.99)
  return next ?? (direction > 0 ? ZOOM_LEVELS[ZOOM_LEVELS.length - 1] : ZOOM_LEVELS[0]) ?? 1
}

type ViewBox = { x: number; y: number; w: number; h: number }

export function viewBoxOf(svg: string): ViewBox | undefined {
  const root = /<svg\b[^>]*>/.exec(svg)?.[0]
  if (!root) return undefined
  const vb = /\sviewBox="\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/.exec(root)
  if (vb) return { x: Number(vb[1]), y: Number(vb[2]), w: Number(vb[3]), h: Number(vb[4]) }
  const w = /\swidth="([\d.]+)(?:px)?"/.exec(root)
  const h = /\sheight="([\d.]+)(?:px)?"/.exec(root)
  return w && h ? { x: 0, y: 0, w: Number(w[1]), h: Number(h[1]) } : undefined
}

export function panStep(zoom: number): number {
  return zoom > 1 ? Math.min(1, 0.5 / (zoom - 1)) : 1
}

export function zoomView(svg: string, zoom: number, pan = 0): { svg: string; from: number; to: number } {
  const z = zoom > 0 ? zoom : 1
  const vb = viewBoxOf(svg)
  const root = /<svg\b[^>]*>/.exec(svg)?.[0]
  if (!vb || !root || z === 1) return { svg, from: 0, to: 1 }
  const vw = vb.w / z
  const p = Math.min(1, Math.max(0, pan))
  const x = z < 1 ? vb.x - (vw - vb.w) / 2 : vb.x + p * (vb.w - vw)
  const stripped = root.replace(/\s(viewBox|width|height|preserveAspectRatio)="[^"]*"/g, '').replace(/\s*\/?>$/, '')
  const rounded = (v: number) => Math.round(v * 100) / 100
  const newRoot = `${stripped} width="${rounded(vw)}" height="${rounded(vb.h)}" viewBox="${rounded(x)} ${rounded(vb.y)} ${rounded(vw)} ${rounded(vb.h)}" preserveAspectRatio="xMinYMin meet">`
  const from = z < 1 ? 0 : (x - vb.x) / vb.w
  return { svg: svg.replace(root, newRoot), from, to: z < 1 ? 1 : from + vw / vb.w }
}

export function zoomLabel(zoom: number, from = 0, to = 1): string {
  const z = zoom > 0 ? zoom : 1
  if (z === 1) return 'fit width'
  const span = z > 1 ? ` · showing ${Math.round(from * 100)}–${Math.round(to * 100)}%` : ''
  return `zoom ${Math.round(z * 100)}%${span}`
}

export type Orientation = 'landscape' | 'portrait'

export function asOrientation(value: unknown): Orientation | undefined {
  return value === 'landscape' || value === 'portrait' ? value : undefined
}
