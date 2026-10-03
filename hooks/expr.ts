// The Obsidian Bases expression language: what `.base` filters, formulas, sort and group
// properties are written in. A tokenizer, a Pratt parser and an evaluator over plain values.
// Anything this does not know raises `Unsupported`, so a caller can say which part of a
// view it skipped instead of silently showing the wrong tasks.

// ── values ───────────────────────────────────────────────────────────────

export class DateV {
  constructor(readonly ms: number, readonly hasTime: boolean) {}
}

export class DurationV {
  constructor(readonly ms: number, readonly months: number) {}
}

export class LinkV {
  constructor(readonly target: string, readonly display?: string) {}
}

/** A vault file as Bases sees it: `file.*` plus its frontmatter as `properties`. */
export class FileV {
  constructor(
    readonly path: string,
    readonly properties: Record<string, unknown>,
    readonly mtime: number,
    readonly ctime: number,
    readonly size: number,
    readonly tags: string[],
    readonly links: string[],
  ) {}
  get name(): string {
    return this.path.slice(this.path.lastIndexOf('/') + 1)
  }
  get basename(): string {
    return this.name.replace(/\.[^.]+$/, '')
  }
  get ext(): string {
    const m = /\.([^.\/]+)$/.exec(this.path)
    return m ? (m[1] ?? '') : ''
  }
  get folder(): string {
    const cut = this.path.lastIndexOf('/')
    return cut < 0 ? '' : this.path.slice(0, cut)
  }
}

/** `this`: the file a base is shown for, with its properties reachable directly. */
class ThisV {
  constructor(readonly file: FileV) {}
}

export type Val = null | boolean | number | string | DateV | DurationV | LinkV | FileV | ThisV | Val[] | { [k: string]: unknown }

export class Unsupported extends Error {}

// ── tokens and syntax ────────────────────────────────────────────────────

type Tok = { k: 'num'; v: number } | { k: 'str'; v: string } | { k: 'id'; v: string } | { k: 'op'; v: string } | { k: 'end' }

const OPS = ['&&', '||', '==', '!=', '<=', '>=', '<', '>', '+', '-', '*', '/', '%', '!', '(', ')', '[', ']', ',', '.']

function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  let k = 0
  while (k < src.length) {
    const c = src[k] ?? ''
    if (/\s/.test(c)) {
      k++
      continue
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[k + 1] ?? ''))) {
      const m = /^(\d+(\.\d+)?|\.\d+)([eE][-+]?\d+)?/.exec(src.slice(k))
      if (!m) throw new Unsupported(`bad number at ${src.slice(k, k + 10)}`)
      out.push({ k: 'num', v: Number(m[0]) })
      k += m[0].length
      continue
    }
    if (c === '"' || c === "'") {
      let s = ''
      let j = k + 1
      for (; j < src.length && src[j] !== c; j++) {
        if (src[j] === '\\') {
          j++
          const e = src[j] ?? ''
          s += ({ n: '\n', t: '\t', r: '\r' } as Record<string, string>)[e] ?? e
        } else s += src[j]
      }
      if (j >= src.length) throw new Unsupported(`unclosed string in ${src}`)
      out.push({ k: 'str', v: s })
      k = j + 1
      continue
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(k))
      const id = m?.[0] ?? c
      out.push({ k: 'id', v: id })
      k += id.length
      continue
    }
    const op = OPS.find(o => src.startsWith(o, k))
    if (!op) throw new Unsupported(`unexpected "${c}" in ${src}`)
    out.push({ k: 'op', v: op })
    k += op.length
  }
  out.push({ k: 'end' })
  return out
}

export type Node =
  | { t: 'lit'; v: Val }
  | { t: 'id'; name: string }
  | { t: 'member'; obj: Node; name: string }
  | { t: 'index'; obj: Node; idx: Node }
  | { t: 'call'; fn: Node; args: Node[] }
  | { t: 'un'; op: string; a: Node }
  | { t: 'bin'; op: string; a: Node; b: Node }
  | { t: 'list'; items: Node[] }

const BINARY: Record<string, number> = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '<=': 4, '>': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 }

class SyntaxParser {
  private k = 0
  constructor(private toks: Tok[], private src: string) {}

  parse(): Node {
    const node = this.expr(0)
    if (this.peek().k !== 'end') throw new Unsupported(`unexpected ${this.show(this.peek())} in ${this.src}`)
    return node
  }

  private peek(): Tok {
    return this.toks[this.k] ?? { k: 'end' }
  }

  private show(t: Tok): string {
    return t.k === 'end' ? 'end' : `"${String(t.v)}"`
  }

  private isOp(v: string): boolean {
    const t = this.peek()
    return t.k === 'op' && t.v === v
  }

  private expect(v: string): void {
    if (!this.isOp(v)) throw new Unsupported(`expected "${v}" but found ${this.show(this.peek())} in ${this.src}`)
    this.k++
  }

  private expr(minPrec: number): Node {
    let left = this.unary()
    for (;;) {
      const t = this.peek()
      if (t.k !== 'op') break
      const prec = BINARY[t.v]
      if (prec === undefined || prec <= minPrec) break
      this.k++
      const right = this.expr(prec)
      left = { t: 'bin', op: t.v, a: left, b: right }
    }
    return left
  }

  private unary(): Node {
    if (this.isOp('!') || this.isOp('-') || this.isOp('+')) {
      const t = this.peek() as { v: string }
      this.k++
      return { t: 'un', op: t.v, a: this.unary() }
    }
    return this.postfix(this.primary())
  }

  private primary(): Node {
    const t = this.peek()
    this.k++
    if (t.k === 'num' || t.k === 'str') return { t: 'lit', v: t.v }
    if (t.k === 'id') {
      if (t.v === 'true') return { t: 'lit', v: true }
      if (t.v === 'false') return { t: 'lit', v: false }
      if (t.v === 'null') return { t: 'lit', v: null }
      return { t: 'id', name: t.v }
    }
    if (t.k === 'op' && t.v === '(') {
      const inner = this.expr(0)
      this.expect(')')
      return inner
    }
    if (t.k === 'op' && t.v === '[') {
      const items: Node[] = []
      while (!this.isOp(']')) {
        items.push(this.expr(0))
        if (!this.isOp(',')) break
        this.k++
      }
      this.expect(']')
      return { t: 'list', items }
    }
    throw new Unsupported(`unexpected ${this.show(t)} in ${this.src}`)
  }

  private postfix(node: Node): Node {
    for (;;) {
      if (this.isOp('.')) {
        this.k++
        const t = this.peek()
        if (t.k !== 'id') throw new Unsupported(`expected a name after "." in ${this.src}`)
        this.k++
        node = { t: 'member', obj: node, name: t.v }
      } else if (this.isOp('(')) {
        this.k++
        const args: Node[] = []
        while (!this.isOp(')')) {
          args.push(this.expr(0))
          if (!this.isOp(',')) break
          this.k++
        }
        this.expect(')')
        node = { t: 'call', fn: node, args }
      } else if (this.isOp('[')) {
        this.k++
        const idx = this.expr(0)
        this.expect(']')
        node = { t: 'index', obj: node, idx }
      } else return node
    }
  }
}

const parsed = new Map<string, Node>()

/** Parse an expression; results are kept, since every row evaluates the same few. */
export function parseExpr(src: string): Node {
  let node = parsed.get(src)
  if (!node) {
    node = new SyntaxParser(tokenize(src), src).parse()
    parsed.set(src, node)
  }
  return node
}

// ── conversions ──────────────────────────────────────────────────────────

const WIKILINK = /^\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]$/

/** A raw frontmatter value as a Bases value: wikilink strings become links. */
export function wrap(raw: unknown): Val {
  if (raw === undefined || raw === null) return null
  if (typeof raw === 'string') {
    const m = WIKILINK.exec(raw.trim())
    return m ? new LinkV((m[1] ?? '').trim(), m[2]?.trim()) : raw
  }
  if (Array.isArray(raw)) return raw.map(wrap)
  if (typeof raw === 'number' || typeof raw === 'boolean') return raw
  if (raw instanceof DateV || raw instanceof LinkV || raw instanceof FileV || raw instanceof DurationV || raw instanceof ThisV) return raw
  if (typeof raw === 'object') return raw as { [k: string]: unknown }
  return String(raw)
}

/** A link's identity: its note name, without folders, `.md`, heading or alias, lowercased. */
export function linkKey(v: unknown): string {
  if (v instanceof FileV) return v.basename.toLowerCase()
  if (v instanceof LinkV) return linkKey(v.target)
  if (v instanceof ThisV) return v.file.basename.toLowerCase()
  if (typeof v !== 'string') return ''
  const m = WIKILINK.exec(v.trim())
  const target = m ? (m[1] ?? '') : v
  return target.trim().replace(/\\/g, '/').replace(/^.*\//, '').replace(/\.md$/i, '').toLowerCase()
}

const DATE_RE = /^(\d{4})-?(\d{2})-?(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/

export function toDate(v: unknown): DateV | null {
  if (v instanceof DateV) return v
  if (typeof v === 'number' && Number.isFinite(v)) return new DateV(v, true)
  if (typeof v !== 'string') return null
  const m = DATE_RE.exec(v.trim())
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])]
  if (m[4] === undefined) return new DateV(new Date(y, mo, d).getTime(), false)
  const h = Number(m[4])
  const mi = Number(m[5])
  const s = Number(m[6] ?? 0)
  const msPart = m[7] ? Number(`0.${m[7]}`) * 1000 : 0
  const tz = m[8]
  if (!tz) return new DateV(new Date(y, mo, d, h, mi, s, msPart).getTime(), true)
  let offset = 0
  if (tz !== 'Z') {
    const sign = tz.startsWith('-') ? -1 : 1
    const digits = tz.slice(1).replace(':', '')
    offset = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)))
  }
  return new DateV(Date.UTC(y, mo, d, h, mi, s, msPart) - offset * 60000, true)
}

const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }

function unitOf(word: string): { ms?: number; months?: number } | undefined {
  if (word === 'M' || /^mon(th)?s?$/i.test(word) || /^mo$/i.test(word)) return { months: 1 }
  if (/^(y|yrs?|years?)$/i.test(word)) return { months: 12 }
  const w = word.toLowerCase()
  if (/^(ms|millis(econds?)?)$/.test(w)) return { ms: UNIT_MS.ms }
  if (/^(s|secs?|seconds?)$/.test(w)) return { ms: UNIT_MS.s }
  if (word === 'm' || /^(mins?|minutes?)$/.test(w)) return { ms: UNIT_MS.m }
  if (/^(h|hrs?|hours?)$/.test(w)) return { ms: UNIT_MS.h }
  if (/^(d|days?)$/.test(w)) return { ms: UNIT_MS.d }
  if (/^(w|wks?|weeks?)$/.test(w)) return { ms: UNIT_MS.w }
  return undefined
}

/** "7d", "7 days", "1 week 2 days", "-1d". */
export function toDuration(v: unknown): DurationV | null {
  if (v instanceof DurationV) return v
  if (typeof v !== 'string') return null
  const re = /(-?\d+(?:\.\d+)?)\s*([A-Za-z]+)/g
  let ms = 0
  let months = 0
  let matched = ''
  for (let m = re.exec(v); m; m = re.exec(v)) {
    const unit = unitOf(m[2] ?? '')
    if (!unit) return null
    const n = Number(m[1])
    ms += n * (unit.ms ?? 0)
    months += n * (unit.months ?? 0)
    matched += m[0]
  }
  return matched.replace(/\s/g, '') === v.replace(/\s/g, '') && matched ? new DurationV(ms, months) : null
}

function shift(d: DateV, dur: DurationV, sign: 1 | -1): DateV {
  const date = new Date(d.ms)
  if (dur.months) date.setMonth(date.getMonth() + sign * dur.months)
  const ms = date.getTime() + sign * dur.ms
  // Whole days keep a date-only value date-only (and across a DST change, at midnight).
  if (!d.hasTime && dur.ms % 86400000 === 0) {
    const days = new Date(date.getTime())
    days.setDate(days.getDate() + (sign * dur.ms) / 86400000)
    return new DateV(days.getTime(), false)
  }
  return new DateV(ms, d.hasTime || dur.ms % 86400000 !== 0)
}

export function truthy(v: Val | undefined): boolean {
  if (v === null || v === undefined || v === false || v === '' || v === 0) return false
  if (typeof v === 'number') return !Number.isNaN(v)
  if (Array.isArray(v)) return v.length > 0
  return true
}

function typeOf(v: Val): string {
  if (v === null) return 'null'
  if (typeof v === 'boolean') return 'boolean'
  if (typeof v === 'number') return 'number'
  if (typeof v === 'string') return 'string'
  if (v instanceof DateV) return 'date'
  if (v instanceof DurationV) return 'duration'
  if (v instanceof LinkV) return 'link'
  if (v instanceof FileV || v instanceof ThisV) return 'file'
  if (Array.isArray(v)) return 'list'
  return 'object'
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function isoWeek(d: Date): { week: number; year: number } {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day)
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1)
  return { week: Math.ceil(((t.getTime() - yearStart) / 86400000 + 1) / 7), year: t.getUTCFullYear() }
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/** Moment-style format tokens, the ones Bases formulas use. */
export function formatDate(ms: number, fmt: string): string {
  const d = new Date(ms)
  return fmt.replace(/\[([^\]]*)\]|YYYY|GGGG|YY|MMMM|MMM|MM|M|Do|DD|D|dddd|ddd|dd|d|HH|H|hh|h|mm|m|ss|s|A|a|WW|W/g, (tok, lit: string | undefined) => {
    if (lit !== undefined) return lit
    switch (tok) {
      case 'YYYY': return String(d.getFullYear())
      case 'GGGG': return String(isoWeek(d).year)
      case 'YY': return pad(d.getFullYear() % 100)
      case 'MMMM': return MONTHS[d.getMonth()] ?? ''
      case 'MMM': return (MONTHS[d.getMonth()] ?? '').slice(0, 3)
      case 'MM': return pad(d.getMonth() + 1)
      case 'M': return String(d.getMonth() + 1)
      case 'Do': {
        const n = d.getDate()
        const sfx = n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'
        return `${n}${sfx}`
      }
      case 'DD': return pad(d.getDate())
      case 'D': return String(d.getDate())
      case 'dddd': return DAYS[d.getDay()] ?? ''
      case 'ddd': return (DAYS[d.getDay()] ?? '').slice(0, 3)
      case 'dd': return (DAYS[d.getDay()] ?? '').slice(0, 2)
      case 'd': return String(d.getDay())
      case 'HH': return pad(d.getHours())
      case 'H': return String(d.getHours())
      case 'hh': return pad(d.getHours() % 12 || 12)
      case 'h': return String(d.getHours() % 12 || 12)
      case 'mm': return pad(d.getMinutes())
      case 'm': return String(d.getMinutes())
      case 'ss': return pad(d.getSeconds())
      case 's': return String(d.getSeconds())
      case 'A': return d.getHours() < 12 ? 'AM' : 'PM'
      case 'a': return d.getHours() < 12 ? 'am' : 'pm'
      case 'WW': return pad(isoWeek(d).week)
      case 'W': return String(isoWeek(d).week)
      default: return tok
    }
  })
}

/** How a value reads in a cell. */
export function toText(v: Val | undefined): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100)
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (v instanceof DateV) return formatDate(v.ms, v.hasTime ? 'YYYY-MM-DD HH:mm' : 'YYYY-MM-DD')
  if (v instanceof DurationV) return `${Math.round(v.ms / 86400000)}d`
  if (v instanceof LinkV) return v.display || v.target
  if (v instanceof FileV) return v.basename
  if (v instanceof ThisV) return v.file.basename
  if (Array.isArray(v)) return v.map(toText).filter(Boolean).join(', ')
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

export function equals(a: Val, b: Val): boolean {
  if (a === null || b === null) return a === b || (a === null && b === '') || (b === null && a === '')
  if (a instanceof LinkV || b instanceof LinkV || a instanceof FileV || b instanceof FileV) {
    const ka = linkKey(a)
    return ka !== '' && ka === linkKey(b)
  }
  if (a instanceof DateV || b instanceof DateV) {
    const da = toDate(a)
    const db = toDate(b)
    return !!da && !!db && da.ms === db.ms
  }
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, k) => equals(x, b[k] ?? null))
  if (typeof a === 'number' && typeof b === 'string') return String(a) === b
  if (typeof b === 'number' && typeof a === 'string') return String(b) === a
  return a === b
}

/** <0, 0, >0, or NaN when the two cannot be ordered (so every comparison is false). */
export function compare(a: Val, b: Val): number {
  if (a === null || b === null) return NaN
  if (a instanceof DateV || b instanceof DateV) {
    const da = toDate(a)
    const db = toDate(b)
    return da && db ? da.ms - db.ms : NaN
  }
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b)
  if (typeof a === 'number' && typeof b === 'string' && b.trim() !== '' && !Number.isNaN(Number(b))) return a - Number(b)
  if (typeof b === 'number' && typeof a === 'string' && a.trim() !== '' && !Number.isNaN(Number(a))) return Number(a) - b
  return toText(a).localeCompare(toText(b), undefined, { numeric: true, sensitivity: 'base' })
}

function containsValue(list: Val[], needle: Val): boolean {
  return list.some(item => {
    if (equals(item, needle)) return true
    // Tags compare without their '#'.
    return typeof item === 'string' && typeof needle === 'string' && item.replace(/^#/, '').toLowerCase() === needle.replace(/^#/, '').toLowerCase()
  })
}

// ── evaluation ───────────────────────────────────────────────────────────

export type Env = {
  file: FileV
  /** The file the base is shown for (`this`); the base file itself when opened directly. */
  thisFile?: FileV
  formulas: Record<string, string>
  /** A link or path to a vault file, as `file()` resolves it. */
  resolve: (target: string) => FileV | undefined
  /** Milliseconds; the clock `today()` and `now()` read. */
  now: number
}

type Locals = { value?: Val; index?: Val; acc?: Val }

/** Evaluates expressions for one file, keeping its formula values. */
export class Evaluator {
  private formulaValues = new Map<string, Val>()
  private computing = new Set<string>()

  constructor(readonly env: Env) {}

  eval(src: string): Val {
    return this.run(parseExpr(src), {})
  }

  formula(name: string): Val {
    if (this.formulaValues.has(name)) return this.formulaValues.get(name) ?? null
    const src = this.env.formulas[name]
    if (src === undefined) return null
    if (this.computing.has(name)) throw new Unsupported(`formula ${name} refers to itself`)
    this.computing.add(name)
    try {
      const v = this.run(parseExpr(String(src)), {})
      this.formulaValues.set(name, v)
      return v
    } finally {
      this.computing.delete(name)
    }
  }

  private today(): DateV {
    const d = new Date(this.env.now)
    return new DateV(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), false)
  }

  private run(n: Node, loc: Locals): Val {
    switch (n.t) {
      case 'lit':
        return n.v
      case 'list':
        return n.items.map(item => this.run(item, loc))
      case 'id':
        return this.ident(n.name, loc)
      case 'member':
        return this.member(n.obj, n.name, loc)
      case 'index': {
        const obj = this.run(n.obj, loc)
        const idx = this.run(n.idx, loc)
        if (Array.isArray(obj) && typeof idx === 'number') return obj[idx < 0 ? obj.length + idx : idx] ?? null
        if (typeof obj === 'string' && typeof idx === 'number') return obj[idx] ?? null
        return this.prop(obj, toText(idx))
      }
      case 'un': {
        const a = this.run(n.a, loc)
        if (n.op === '!') return !truthy(a)
        const num = typeof a === 'number' ? a : Number(a)
        if (a === null || Number.isNaN(num)) return null
        return n.op === '-' ? -num : num
      }
      case 'bin':
        return this.binary(n.op, n.a, n.b, loc)
      case 'call':
        return this.call(n, loc)
    }
  }

  private ident(name: string, loc: Locals): Val {
    if (name === 'value' && 'value' in loc) return loc.value ?? null
    if (name === 'index' && 'index' in loc) return loc.index ?? null
    if (name === 'acc' && 'acc' in loc) return loc.acc ?? null
    if (name === 'file') return this.env.file
    if (name === 'note') return this.env.file.properties as { [k: string]: unknown }
    if (name === 'this') return this.env.thisFile ? new ThisV(this.env.thisFile) : null
    if (name === 'formula') throw new Unsupported('"formula" needs a name: formula.<name>')
    return wrap(this.env.file.properties[name])
  }

  private member(objNode: Node, name: string, loc: Locals): Val {
    if (objNode.t === 'id' && objNode.name === 'formula') return this.formula(name)
    return this.prop(this.run(objNode, loc), name)
  }

  private prop(obj: Val, name: string): Val {
    if (obj === null) return null
    if (obj instanceof ThisV) {
      if (name === 'file') return obj.file
      if (name === 'note') return obj.file.properties as { [k: string]: unknown }
      return wrap(obj.file.properties[name])
    }
    if (obj instanceof LinkV) {
      const f = this.env.resolve(obj.target)
      return f ? this.prop(f, name) : null
    }
    if (obj instanceof FileV) {
      switch (name) {
        case 'name': return obj.name
        case 'basename': return obj.basename
        case 'path': return obj.path
        case 'folder': return obj.folder
        case 'ext': return obj.ext
        case 'size': return obj.size
        case 'mtime': return new DateV(obj.mtime, true)
        case 'ctime': return new DateV(obj.ctime, true)
        case 'tags': return [...obj.tags]
        case 'links': return obj.links.map(l => new LinkV(l))
        case 'properties': return obj.properties as { [k: string]: unknown }
        case 'file': return obj
        default: throw new Unsupported(`file.${name} is not supported`)
      }
    }
    if (obj instanceof DateV) {
      const d = new Date(obj.ms)
      switch (name) {
        case 'year': return d.getFullYear()
        case 'month': return d.getMonth() + 1
        case 'day': return d.getDate()
        case 'hour': return d.getHours()
        case 'minute': return d.getMinutes()
        case 'second': return d.getSeconds()
        case 'millisecond': return d.getMilliseconds()
        default: throw new Unsupported(`date.${name} is not supported`)
      }
    }
    if (typeof obj === 'string' || Array.isArray(obj)) {
      if (name === 'length') return obj.length
      return null
    }
    if (typeof obj === 'object' && !(obj instanceof DurationV)) return wrap((obj as Record<string, unknown>)[name])
    return null
  }

  private binary(op: string, an: Node, bn: Node, loc: Locals): Val {
    if (op === '&&') return truthy(this.run(an, loc)) && truthy(this.run(bn, loc))
    if (op === '||') return truthy(this.run(an, loc)) || truthy(this.run(bn, loc))
    const a = this.run(an, loc)
    const b = this.run(bn, loc)
    switch (op) {
      case '==': return equals(a, b)
      case '!=': return !equals(a, b)
      case '<': return compare(a, b) < 0
      case '<=': return compare(a, b) <= 0
      case '>': return compare(a, b) > 0
      case '>=': return compare(a, b) >= 0
    }
    if (a instanceof DateV && (op === '+' || op === '-')) {
      const dur = toDuration(b)
      if (dur) return shift(a, dur, op === '+' ? 1 : -1)
      const other = toDate(b)
      if (op === '-' && other) return a.ms - other.ms
    }
    if (op === '+') {
      if (typeof a === 'number' && typeof b === 'number') return a + b
      if (typeof a === 'string' || typeof b === 'string') return toText(a) + toText(b)
      if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b]
      if (a === null || b === null) return null
    }
    const x = typeof a === 'number' ? a : a === null ? NaN : Number(a)
    const y = typeof b === 'number' ? b : b === null ? NaN : Number(b)
    if (Number.isNaN(x) || Number.isNaN(y)) return null
    switch (op) {
      case '+': return x + y
      case '-': return x - y
      case '*': return x * y
      case '/': return y === 0 ? null : x / y
      case '%': return y === 0 ? null : x % y
    }
    throw new Unsupported(`operator ${op}`)
  }

  private call(n: { fn: Node; args: Node[] }, loc: Locals): Val {
    if (n.fn.t === 'id') return this.global(n.fn.name, n.args, loc)
    if (n.fn.t === 'member') {
      const target = this.run(n.fn.obj, loc)
      return this.method(target, n.fn.name, n.args, loc)
    }
    throw new Unsupported('only functions and methods can be called')
  }

  private global(name: string, args: Node[], loc: Locals): Val {
    const arg = (k: number) => (args[k] ? this.run(args[k] as Node, loc) : null)
    switch (name) {
      case 'if':
        return truthy(arg(0)) ? arg(1) : args.length > 2 ? arg(2) : null
      case 'today':
        return this.today()
      case 'now':
        return new DateV(this.env.now, true)
      case 'date':
        return toDate(arg(0))
      case 'duration':
        return toDuration(arg(0))
      case 'number': {
        const v = arg(0)
        if (v === null) return null
        if (v instanceof DateV) return v.ms
        if (v instanceof DurationV) return v.ms
        if (typeof v === 'boolean') return v ? 1 : 0
        if (typeof v === 'number') return v
        const num = Number(toText(v))
        return Number.isNaN(num) ? null : num
      }
      case 'string':
        return toText(arg(0))
      case 'list': {
        const v = arg(0)
        return v === null ? [] : Array.isArray(v) ? v : [v]
      }
      case 'file': {
        const v = arg(0)
        if (v instanceof FileV) return v
        if (v instanceof ThisV) return v.file
        if (v === null) return null
        return this.env.resolve(v instanceof LinkV ? v.target : toText(v)) ?? null
      }
      case 'link': {
        const v = arg(0)
        const display = args.length > 1 ? toText(arg(1)) : undefined
        if (v instanceof FileV) return new LinkV(v.basename, display)
        return v === null ? null : new LinkV(v instanceof LinkV ? v.target : toText(v), display)
      }
      case 'max':
      case 'min': {
        const nums = args.map(a => this.run(a, loc)).flat().filter((v): v is number => typeof v === 'number' && !Number.isNaN(v))
        if (!nums.length) return null
        return name === 'max' ? Math.max(...nums) : Math.min(...nums)
      }
      default:
        throw new Unsupported(`function ${name}() is not supported`)
    }
  }

  private method(target: Val, name: string, args: Node[], loc: Locals): Val {
    const arg = (k: number) => (args[k] ? this.run(args[k] as Node, loc) : null)
    const all = () => args.map(a => this.run(a, loc))

    // Every type
    switch (name) {
      case 'isEmpty':
        if (target === null || target === '') return true
        if (Array.isArray(target)) return target.length === 0
        if (typeof target === 'object' && !(target instanceof DateV || target instanceof LinkV || target instanceof FileV || target instanceof ThisV || target instanceof DurationV)) {
          return Object.keys(target).length === 0
        }
        return false
      case 'isType':
        return typeOf(target) === toText(arg(0)).toLowerCase()
      case 'isTruthy':
        return truthy(target)
      case 'toString':
        return toText(target)
    }
    if (target === null) return null

    if (target instanceof ThisV) return this.method(target.file, name, args, loc)
    if (target instanceof LinkV) {
      if (name === 'asFile') return this.env.resolve(target.target) ?? null
      if (name === 'linksTo') return equals(target, arg(0))
      const f = this.env.resolve(target.target)
      return f ? this.method(f, name, args, loc) : null
    }

    if (target instanceof FileV) {
      switch (name) {
        case 'hasTag': {
          const own = target.tags.map(t => t.replace(/^#/, '').toLowerCase())
          return all().some(tag => {
            const want = toText(tag).replace(/^#/, '').toLowerCase()
            return own.some(t => t === want || t.startsWith(`${want}/`))
          })
        }
        case 'inFolder': {
          const folder = toText(arg(0)).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase()
          const path = target.path.toLowerCase()
          return folder === '' || path.startsWith(`${folder}/`)
        }
        case 'hasLink': {
          const key = linkKey(arg(0))
          return target.links.some(l => linkKey(l) === key)
        }
        case 'hasProperty':
          return Object.prototype.hasOwnProperty.call(target.properties, toText(arg(0)))
        case 'asLink':
          return new LinkV(target.basename, args.length ? toText(arg(0)) : undefined)
        case 'linksTo':
          return target.links.some(l => linkKey(l) === linkKey(arg(0)))
        default:
          throw new Unsupported(`file.${name}() is not supported`)
      }
    }

    if (target instanceof DateV) {
      switch (name) {
        case 'date': {
          const d = new Date(target.ms)
          return new DateV(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), false)
        }
        case 'format':
          return formatDate(target.ms, args.length ? toText(arg(0)) : 'YYYY-MM-DD')
        case 'time':
          return formatDate(target.ms, 'HH:mm:ss')
        case 'relative': {
          const days = Math.round((target.ms - this.today().ms) / 86400000)
          if (days === 0) return 'today'
          return days > 0 ? `in ${days} day${days === 1 ? '' : 's'}` : `${-days} day${days === -1 ? '' : 's'} ago`
        }
        default:
          throw new Unsupported(`date.${name}() is not supported`)
      }
    }

    if (typeof target === 'number') {
      switch (name) {
        case 'floor': return Math.floor(target)
        case 'ceil': return Math.ceil(target)
        case 'abs': return Math.abs(target)
        case 'round': {
          const digits = args.length ? Number(arg(0)) : 0
          const f = 10 ** (Number.isFinite(digits) ? digits : 0)
          return Math.round(target * f) / f
        }
        case 'toFixed': return target.toFixed(Number(arg(0) ?? 0))
        default: throw new Unsupported(`number.${name}() is not supported`)
      }
    }

    if (typeof target === 'string') {
      const s = target
      switch (name) {
        case 'contains': return s.toLowerCase().includes(toText(arg(0)).toLowerCase())
        case 'containsAll': return all().every(x => s.toLowerCase().includes(toText(x).toLowerCase()))
        case 'containsAny': return all().some(x => s.toLowerCase().includes(toText(x).toLowerCase()))
        case 'startsWith': return s.startsWith(toText(arg(0)))
        case 'endsWith': return s.endsWith(toText(arg(0)))
        case 'lower': return s.toLowerCase()
        case 'upper': return s.toUpperCase()
        case 'title': return s.replace(/\b\w/g, c => c.toUpperCase())
        case 'trim': return s.trim()
        case 'reverse': return Array.from(s).reverse().join('')
        case 'repeat': return s.repeat(Math.max(0, Number(arg(0)) || 0))
        case 'slice': return s.slice(Number(arg(0)) || 0, args.length > 1 ? Number(arg(1)) : undefined)
        case 'split': return s.split(toText(arg(0)))
        case 'replace': return s.split(toText(arg(0))).join(toText(arg(1)))
        default: throw new Unsupported(`string.${name}() is not supported`)
      }
    }

    if (Array.isArray(target)) {
      const lambda = (body: Node | undefined, item: Val, index: number, acc?: Val): Val => {
        if (!body) throw new Unsupported(`${name}() needs an expression`)
        const locals: Locals = { value: item, index }
        if (acc !== undefined) locals.acc = acc
        return this.run(body, locals)
      }
      switch (name) {
        case 'contains': return containsValue(target, arg(0))
        case 'hasTag': {
          // A tags list asked like file.hasTag: any of the tags, nested tags included.
          const own = target.map(t => toText(t).replace(/^#/, '').toLowerCase())
          return all().some(tag => {
            const want = toText(tag).replace(/^#/, '').toLowerCase()
            return own.some(t => t === want || t.startsWith(`${want}/`))
          })
        }
        case 'containsAll': return all().every(x => containsValue(target, x))
        case 'containsAny': return all().some(x => containsValue(target, x))
        case 'filter': return target.filter((item, k) => truthy(lambda(args[0], item, k)))
        case 'map': return target.map((item, k) => lambda(args[0], item, k))
        case 'reduce': {
          let acc: Val = args.length > 1 ? this.run(args[1] as Node, loc) : null
          target.forEach((item, k) => {
            acc = lambda(args[0], item, k, acc)
          })
          return acc
        }
        case 'any': return target.some((item, k) => truthy(lambda(args[0], item, k)))
        case 'all': return target.every((item, k) => truthy(lambda(args[0], item, k)))
        case 'join': return target.map(toText).join(args.length ? toText(arg(0)) : ', ')
        case 'sort': return [...target].sort((a, b) => compare(a, b) || 0)
        case 'reverse': return [...target].reverse()
        case 'unique': return target.filter((item, k) => target.findIndex(o => equals(o, item)) === k)
        case 'flat': return target.flat()
        case 'slice': return target.slice(Number(arg(0)) || 0, args.length > 1 ? Number(arg(1)) : undefined)
        default: throw new Unsupported(`list.${name}() is not supported`)
      }
    }

    if (typeof target === 'object' && !(target instanceof DurationV)) {
      const obj = target as Record<string, unknown>
      if (name === 'keys') return Object.keys(obj)
      if (name === 'values') return Object.values(obj).map(wrap)
    }
    throw new Unsupported(`${typeOf(target)}.${name}() is not supported`)
  }
}
