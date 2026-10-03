// A small YAML reader for note frontmatter and Obsidian `.base` files. A plugin has no npm
// packages, so this covers the subset Obsidian and TaskNotes write: block mappings and
// sequences (a sequence may sit at its key's own indent), sequences of mappings, flow
// `[...]` / `{...}`, plain, single- and double-quoted scalars (over several lines too),
// block scalars (`|`, `>`, with `-`/`+`), and comments. Dates stay strings: Bases converts
// them with `date()`, as Obsidian does.

type Line = { indent: number; text: string }

export class YamlError extends Error {}

export function parseYaml(src: string): unknown {
  const lines: (Line | undefined)[] = src.replace(/\r/g, '').split('\n').map(raw => {
    const text = raw.replace(/\t/g, '  ')
    const trimmed = text.trimStart()
    return { indent: text.length - trimmed.length, text: trimmed.trimEnd() }
  })
  const p = new Parser(lines)
  return p.document()
}

/** Split a markdown note into its frontmatter object and body. */
export function splitFrontmatter(text: string): { data: Record<string, unknown>; body: string; error?: string } {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text)
  if (!m) return { data: {}, body: text }
  const body = text.slice(m[0].length)
  try {
    const parsed = parseYaml(m[1] ?? '')
    return { data: isRecord(parsed) ? parsed : {}, body }
  } catch (err) {
    return { data: {}, body, error: err instanceof Error ? err.message : String(err) }
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const KEY = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^\s'"#[\]{},&*!|>%@`-][^:]*?|-[^\s:][^:]*?))[ \t]*:(?:[ \t]+(.*)|$)/

function isSeqItem(text: string): boolean {
  return text === '-' || text.startsWith('- ')
}

function isBlank(line: Line | undefined): boolean {
  return !line || line.text === '' || line.text.startsWith('#')
}

class Parser {
  i = 0
  constructor(private lines: (Line | undefined)[]) {}

  document(): unknown {
    this.skip()
    const first = this.lines[this.i]
    if (!first) return null
    if (first.text === '---') {
      this.i++
      this.skip()
    }
    const line = this.lines[this.i]
    if (!line) return null
    return this.node(line.indent)
  }

  private skip(): void {
    while (this.i < this.lines.length && isBlank(this.lines[this.i])) this.i++
  }

  private peek(): Line | undefined {
    this.skip()
    return this.lines[this.i]
  }

  private node(indent: number): unknown {
    const line = this.peek()
    if (!line || line.indent < indent) return null
    if (isSeqItem(line.text)) return this.seq(line.indent)
    if (KEY.test(line.text)) return this.map(line.indent)
    this.i++
    return this.inline(line.text, line.indent - 1)
  }

  private map(indent: number): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (;;) {
      const line = this.peek()
      if (!line || line.indent !== indent || isSeqItem(line.text)) break
      const m = KEY.exec(line.text)
      if (!m) throw new YamlError(`expected "key: value" at "${line.text.slice(0, 60)}"`)
      const key = m[1] !== undefined ? unescapeDouble(m[1]) : m[2] !== undefined ? m[2].replace(/''/g, "'") : (m[3] ?? '').trim()
      const rest = (m[4] ?? '').trim()
      this.i++
      out[key] = this.value(rest, indent)
    }
    return out
  }

  /** The value after `key:` (or `- `), with `indent` the column of its owner. */
  private value(rest: string, indent: number): unknown {
    if (rest === '' || rest.startsWith('#')) {
      const next = this.peek()
      if (!next) return null
      if (next.indent > indent) return this.node(next.indent)
      // A sequence may sit at its key's own indent.
      if (next.indent === indent && isSeqItem(next.text)) return this.seq(indent)
      return null
    }
    if (/^[|>][+-]?\d*$/.test(rest.replace(/\s+#.*$/, ''))) return this.blockScalar(rest, indent)
    return this.inline(rest, indent)
  }

  private seq(indent: number): unknown[] {
    const out: unknown[] = []
    for (;;) {
      const line = this.peek()
      if (!line || line.indent !== indent || !isSeqItem(line.text)) break
      const content = line.text === '-' ? '' : line.text.slice(2).trimStart()
      const offset = line.indent + (line.text.length - content.length)
      if (content === '') {
        this.i++
        out.push(this.value('', indent))
      } else if (isSeqItem(content) || startsAsKey(content)) {
        // `- key: v` (a mapping) or `- - x` (a nested sequence): re-read this line as the
        // first line of that node, at the column its content starts.
        this.lines[this.i] = { indent: offset, text: content }
        out.push(this.node(offset))
      } else {
        this.i++
        out.push(this.inline(content, indent))
      }
    }
    return out
  }

  private blockScalar(header: string, indent: number): string {
    const fold = header.startsWith('>')
    const chomp = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip'
    const raw: string[] = []
    let blockIndent = -1
    while (this.i < this.lines.length) {
      const line = this.lines[this.i]
      if (!line) break
      if (line.text === '') {
        raw.push('')
        this.i++
        continue
      }
      if (line.indent <= indent) break
      if (blockIndent < 0) blockIndent = line.indent
      if (line.indent < blockIndent) break
      raw.push(' '.repeat(line.indent - blockIndent) + line.text)
      this.i++
    }
    let text: string
    if (fold) {
      text = raw.reduce((acc, l, k) => {
        if (k === 0) return l
        const prev = raw[k - 1] ?? ''
        if (l === '' || prev === '' || l.startsWith(' ')) return `${acc}\n${l}`
        return `${acc} ${l}`
      }, '')
    } else {
      text = raw.join('\n')
    }
    if (chomp === 'strip') return text.replace(/\n+$/, '')
    if (chomp === 'clip') return text.replace(/\n+$/, '') + '\n'
    return text + '\n'
  }

  /**
   * A scalar or flow collection starting on this line; quoted, flow and plain scalars may
   * continue on following lines indented deeper than `indent`.
   */
  private inline(first: string, indent: number): unknown {
    let text = first
    const continues = () => {
      const next = this.lines[this.i]
      return !!next && next.text !== '' && next.indent > indent && !next.text.startsWith('#')
    }
    if (text.startsWith('"') || text.startsWith("'")) {
      const q = text[0] as '"' | "'"
      while (!closedQuote(text, q) && this.i < this.lines.length) {
        const next = this.lines[this.i]
        this.i++
        text += next && next.text !== '' ? ` ${next.text}` : '\n'
      }
      const end = closingQuoteAt(text, q)
      const body = text.slice(1, end)
      return q === '"' ? unescapeDouble(body) : body.replace(/''/g, "'")
    }
    if (text.startsWith('[') || text.startsWith('{')) {
      while (!balanced(text) && this.i < this.lines.length) {
        const next = this.lines[this.i]
        this.i++
        if (next) text += ` ${next.text}`
      }
      return new Flow(text).value()
    }
    const plain = stripComment(text)
    const parts = [plain]
    while (continues() && !KEY.test(this.lines[this.i]?.text ?? '') && !isSeqItem(this.lines[this.i]?.text ?? '')) {
      parts.push(stripComment(this.lines[this.i]?.text ?? ''))
      this.i++
    }
    return parts.length > 1 ? parts.join(' ') : scalar(plain)
  }
}

/**
 * `- foo: bar` reads as a mapping only when the part before `:` looks like a key, so a
 * filter expression such as `- file.name == "a: b"` stays one string.
 */
function startsAsKey(content: string): boolean {
  const m = KEY.exec(content)
  if (!m) return false
  return m[3] === undefined || !/[()"'=<>!&|]/.test(m[3])
}

function closingQuoteAt(text: string, q: string): number {
  for (let k = 1; k < text.length; k++) {
    const c = text[k]
    if (q === '"' && c === '\\') {
      k++
      continue
    }
    if (c === q) {
      if (q === "'" && text[k + 1] === "'") {
        k++
        continue
      }
      return k
    }
  }
  return -1
}

function closedQuote(text: string, q: string): boolean {
  return closingQuoteAt(text, q) > 0
}

function balanced(text: string): boolean {
  let depth = 0
  let quote: string | undefined
  for (let k = 0; k < text.length; k++) {
    const c = text[k]
    if (quote) {
      if (quote === '"' && c === '\\') k++
      else if (c === quote) quote = undefined
    } else if (c === '"' || c === "'") quote = c
    else if (c === '[' || c === '{') depth++
    else if (c === ']' || c === '}') depth--
  }
  return depth <= 0
}

function stripComment(text: string): string {
  const m = /\s#/.exec(text)
  return (m ? text.slice(0, m.index) : text).trim()
}

function unescapeDouble(s: string): string {
  return s.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, e: string) => {
    if (e[0] === 'u' || e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16))
    return ({ n: '\n', t: '\t', r: '\r', '0': '\0', '"': '"', '\\': '\\', '/': '/', ' ': ' ' } as Record<string, string>)[e] ?? e
  })
}

/** A plain scalar: null, booleans and numbers become values; everything else stays text. */
export function scalar(text: string): unknown {
  const t = text.trim()
  if (t === '' || t === '~' || t === 'null' || t === 'Null' || t === 'NULL') return null
  if (/^(true|True|TRUE)$/.test(t)) return true
  if (/^(false|False|FALSE)$/.test(t)) return false
  if (/^[-+]?(\d+|\d*\.\d+)([eE][-+]?\d+)?$/.test(t)) return Number(t)
  if (/^0x[0-9a-fA-F]+$/.test(t)) return parseInt(t, 16)
  return t
}

class Flow {
  k = 0
  constructor(private s: string) {}

  value(): unknown {
    this.ws()
    const c = this.s[this.k]
    if (c === '[') return this.list()
    if (c === '{') return this.object()
    return this.atom(false)
  }

  private ws(): void {
    while (this.k < this.s.length && /\s/.test(this.s[this.k] ?? '')) this.k++
  }

  private list(): unknown[] {
    const out: unknown[] = []
    this.k++ // [
    for (;;) {
      this.ws()
      if (this.s[this.k] === ']') {
        this.k++
        return out
      }
      if (this.k >= this.s.length) throw new YamlError('unclosed [')
      out.push(this.value())
      this.ws()
      if (this.s[this.k] === ',') this.k++
    }
  }

  private object(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    this.k++ // {
    for (;;) {
      this.ws()
      if (this.s[this.k] === '}') {
        this.k++
        return out
      }
      if (this.k >= this.s.length) throw new YamlError('unclosed {')
      const key = String(this.atom(true) ?? '')
      this.ws()
      let val: unknown = null
      if (this.s[this.k] === ':') {
        this.k++
        val = this.value()
      }
      out[key] = val
      this.ws()
      if (this.s[this.k] === ',') this.k++
    }
  }

  private atom(isKey: boolean): unknown {
    this.ws()
    const c = this.s[this.k]
    if (c === '"' || c === "'") {
      const rest = this.s.slice(this.k)
      const end = closingQuoteAt(rest, c)
      if (end < 0) throw new YamlError('unclosed quote')
      this.k += end + 1
      const body = rest.slice(1, end)
      return c === '"' ? unescapeDouble(body) : body.replace(/''/g, "'")
    }
    const start = this.k
    while (this.k < this.s.length) {
      const ch = this.s[this.k]
      if (ch === ',' || ch === ']' || ch === '}') break
      if (isKey && ch === ':') break
      if (ch === ':' && /\s/.test(this.s[this.k + 1] ?? ' ')) break
      this.k++
    }
    return scalar(this.s.slice(start, this.k))
  }
}
