/**
 * Minimal XML reader, enough for KB84 .pro files and independent of DOMParser (runs in the browser and in node).
 * Supports elements, attributes ('…' or "…"), self-closing tags, comments, processing instructions, CDATA and
 * <!DOCTYPE> without an internal subset (all skipped), the five predefined entities and numeric character references.
 * Text content is ignored.
 */

export interface XmlElement {
  name: string
  attrs: Map<string, string>
  children: XmlElement[]
  /** 1-based line of the start tag. */
  line: number
}

export class XmlError extends Error {
  line: number
  constructor(message: string, line: number) {
    super(`XML error at line ${line}: ${message}`)
    this.name = 'XmlError'
    this.line = line
  }
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }
const NAME = /[^\s/>=<"'!?]+/y
const SPACE = /\s*/y

function decodeEntities(raw: string, line: number): string {
  if (!raw.includes('&')) return raw
  return raw.replace(/&([^;&\s]*)(;?)/g, (match, body: string, semi: string) => {
    if (!semi) throw new XmlError(`unterminated entity reference "${match}"`, line)
    if (body.startsWith('#')) {
      const hex = body.startsWith('#x')
      const digits = body.slice(hex ? 2 : 1)
      const cp = (hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits) ? parseInt(digits, hex ? 16 : 10) : NaN
      if (!(cp > 0 && cp <= 0x10ffff)) throw new XmlError(`invalid character reference "${match}"`, line)
      return String.fromCodePoint(cp)
    }
    const value = ENTITIES[body]
    if (value === undefined) throw new XmlError(`unknown entity "${match}"`, line)
    return value
  })
}

/** Parses a whole document and returns its root element. Throws XmlError on malformed input. */
export function parseXml(text: string): XmlElement {
  let pos = 0
  // Line tracking: positions only move forward, so count newlines incrementally.
  let line = 1
  let scanned = 0
  const lineAt = (p: number) => {
    for (; scanned < p && scanned < text.length; scanned++) if (text.charCodeAt(scanned) === 10) line++
    return line
  }
  const fail = (message: string, p = pos): never => {
    throw new XmlError(message, lineAt(p))
  }
  const skipSpace = () => {
    SPACE.lastIndex = pos
    SPACE.exec(text)
    pos = SPACE.lastIndex
  }
  const readName = (): string => {
    NAME.lastIndex = pos
    const m = NAME.exec(text)
    if (!m) return fail('expected a name')
    pos = NAME.lastIndex
    return m[0]
  }
  const skipPast = (terminator: string, what: string) => {
    const end = text.indexOf(terminator, pos)
    if (end < 0) fail(`unterminated ${what}`)
    pos = end + terminator.length
  }

  const stack: XmlElement[] = []
  let root: XmlElement | null = null

  while (pos < text.length) {
    const lt = text.indexOf('<', pos)
    const textEnd = lt < 0 ? text.length : lt
    if (stack.length === 0 && text.slice(pos, textEnd).trim() !== '') fail('text outside the root element')
    if (lt < 0) break
    pos = lt
    if (text.startsWith('<!--', pos)) skipPast('-->', 'comment')
    else if (text.startsWith('<?', pos)) skipPast('?>', 'processing instruction')
    else if (text.startsWith('<![CDATA[', pos)) skipPast(']]>', 'CDATA section')
    else if (text.startsWith('<!', pos)) skipPast('>', 'declaration')
    else if (text.startsWith('</', pos)) {
      pos += 2
      const name = readName()
      skipSpace()
      if (text[pos] !== '>') fail(`expected ">" to close </${name}`)
      pos++
      const open = stack.pop()
      if (!open) fail(`unexpected closing tag </${name}>`, lt)
      else if (open.name !== name) fail(`closing tag </${name}> does not match <${open.name}> (line ${open.line})`, lt)
    } else {
      pos++
      const el: XmlElement = { name: readName(), attrs: new Map(), children: [], line: lineAt(lt) }
      let selfClosing = false
      for (;;) {
        skipSpace()
        if (text.startsWith('/>', pos)) {
          pos += 2
          selfClosing = true
          break
        }
        if (text[pos] === '>') {
          pos++
          break
        }
        if (pos >= text.length) fail(`unterminated start tag <${el.name}>`, lt)
        const attr = readName()
        skipSpace()
        if (text[pos] !== '=') fail(`expected "=" after attribute ${attr}`)
        pos++
        skipSpace()
        const quote = text[pos]
        if (quote !== '"' && quote !== "'") fail(`expected a quoted value for attribute ${attr}`)
        const end = text.indexOf(quote, pos + 1)
        if (end < 0) fail(`unterminated value of attribute ${attr}`)
        const raw = text.slice(pos + 1, end)
        if (raw.includes('<')) fail(`"<" in the value of attribute ${attr}`)
        if (el.attrs.has(attr)) fail(`duplicate attribute ${attr} on <${el.name}>`)
        el.attrs.set(attr, decodeEntities(raw, lineAt(pos)))
        pos = end + 1
      }
      const parent = stack[stack.length - 1]
      if (parent) parent.children.push(el)
      else if (root) fail('more than one root element', lt)
      else root = el
      if (!selfClosing) stack.push(el)
    }
  }
  if (stack.length) fail(`element <${stack[stack.length - 1].name}> (line ${stack[stack.length - 1].line}) is not closed`)
  if (!root) return fail('no root element')
  return root
}
