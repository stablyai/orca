/**
 * Tiny forward-only scanner for the SpreadsheetML parts of a workbook.
 *
 * Why not DOMParser: worksheet XML is the hot path (one element per cell, and a
 * large sheet has millions), and building a full DOM allocates a node per cell
 * before a single row is rendered. Scanning by tag name also keeps the parser
 * usable from Node — the renderer's Vitest environment has no DOMParser.
 */
export type XlsxXmlElement = {
  attributes: Record<string, string>
  /** Raw inner XML; empty for self-closing elements. */
  inner: string
}

/**
 * Visits every `<tagName>` element in document order. Return `false` from
 * `visit` to stop scanning early.
 */
export function forEachXlsxXmlElement(
  xml: string,
  tagName: string,
  visit: (element: XlsxXmlElement) => boolean | void
): void {
  let cursor = 0

  while (cursor < xml.length) {
    const openTagStart = findOpenTagStart(xml, tagName, cursor)
    if (openTagStart === -1) {
      return
    }
    const attributesStart = openTagStart + tagName.length + 1
    const openTag = scanOpenTag(xml, attributesStart)
    if (openTag === null) {
      return
    }

    const attributes = parseXlsxXmlAttributes(xml.slice(attributesStart, openTag.attributesEnd))
    if (openTag.selfClosing) {
      if (visit({ attributes, inner: '' }) === false) {
        return
      }
      cursor = openTag.tagEnd + 1
      continue
    }

    const innerStart = openTag.tagEnd + 1
    const innerEnd = findCloseTagStart(xml, tagName, innerStart)
    if (visit({ attributes, inner: xml.slice(innerStart, innerEnd) }) === false) {
      return
    }
    cursor = innerEnd + tagName.length + 3
  }
}

// Why: `<rPh>` holds the phonetic reading of a Japanese string (furigana) and
// carries its own `<t>` runs. Excel shows it above the cell, never inside the
// value, so it has to go before the runs are concatenated. The self-closing form
// is matched first so a later `</rPh>` cannot make the lazy match span real text.
const PHONETIC_RUN_PATTERN = /<rPh(?:\s[^>]*)?\/>|<rPh[\s>][\s\S]*?<\/rPh>/g

/**
 * Concatenates the text of every `<t>` element, the SpreadsheetML text run.
 *
 * Shared, inline and rich-text cells all store their value this way, so they all
 * come through here and get the same treatment.
 */
export function readXlsxXmlTextRuns(xml: string): string {
  let text = ''
  forEachXlsxXmlElement(xml.replace(PHONETIC_RUN_PATTERN, ''), 't', (element) => {
    text += decodeXlsxXmlText(element.inner)
  })
  return text
}

export function parseXlsxXmlAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  const pattern = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let match = pattern.exec(raw)

  while (match) {
    attributes[match[1]!] = decodeXlsxXmlText(match[2] ?? match[3] ?? '')
    match = pattern.exec(raw)
  }

  return attributes
}

const XML_NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'"
}

export function decodeXlsxXmlText(value: string): string {
  if (!value.includes('&')) {
    return value
  }
  // Why: `&#X41;` is not well-formed XML — the spec only allows a lowercase `x`
  // — but accepting it costs nothing and shows the character a sloppy producer
  // meant instead of leaking markup into the cell.
  return value.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (entity, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      return codePointToString(Number.parseInt(body.slice(2), 16), entity)
    }
    if (body.startsWith('#')) {
      return codePointToString(Number.parseInt(body.slice(1), 10), entity)
    }
    return XML_NAMED_ENTITIES[body] ?? entity
  })
}

const SLASH = 47
const GREATER_THAN = 62
const DOUBLE_QUOTE = 34
const SINGLE_QUOTE = 39

type XlsxXmlOpenTag = {
  /** End of the attribute region: before `/` on a self-closing tag. */
  attributesEnd: number
  /** Index of the `>` that closes the open tag. */
  tagEnd: number
  selfClosing: boolean
}

// Why: XML only requires `<` and `&` to be escaped inside an attribute value, so
// a value may legally contain `>`. Finding the end of the tag with indexOf('>')
// would stop inside such a value and desync attribute parsing — track quote
// state instead. Once the scan is outside quotes at `>`, a preceding `/` is
// necessarily outside quotes too, so the self-closing check is safe here.
function scanOpenTag(xml: string, attributesStart: number): XlsxXmlOpenTag | null {
  let openQuote = 0

  for (let index = attributesStart; index < xml.length; index += 1) {
    const codeUnit = xml.charCodeAt(index)
    if (openQuote !== 0) {
      if (codeUnit === openQuote) {
        openQuote = 0
      }
      continue
    }
    if (codeUnit === DOUBLE_QUOTE || codeUnit === SINGLE_QUOTE) {
      openQuote = codeUnit
      continue
    }
    if (codeUnit === GREATER_THAN) {
      const selfClosing = index > attributesStart && xml.charCodeAt(index - 1) === SLASH
      return { attributesEnd: selfClosing ? index - 1 : index, tagEnd: index, selfClosing }
    }
  }

  return null
}

function codePointToString(codePoint: number, entity: string): string {
  // Why: leave malformed or out-of-range references untouched rather than
  // throwing — a viewer should still show the rest of the cell.
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return entity
  }
  return String.fromCodePoint(codePoint)
}

// Why: `<c>` must not match `<cols>` or `<cellXfs>`, so a candidate only counts
// when the character after the name ends it.
function findOpenTagStart(xml: string, tagName: string, from: number): number {
  const needle = `<${tagName}`
  let candidate = xml.indexOf(needle, from)

  while (candidate !== -1) {
    if (isTagNameBoundary(xml.charCodeAt(candidate + needle.length))) {
      return candidate
    }
    candidate = xml.indexOf(needle, candidate + 1)
  }

  return -1
}

function isTagNameBoundary(codeUnit: number): boolean {
  return (
    Number.isNaN(codeUnit) ||
    codeUnit === 62 || // >
    codeUnit === SLASH ||
    codeUnit === 32 || // space
    codeUnit === 9 || // tab
    codeUnit === 10 || // line feed
    codeUnit === 13 // carriage return
  )
}

// Why: track nesting depth so an element that legally contains another of the
// same name (`<is>` inside `<is>` never happens, but `<row>` inside a nested
// table part could) closes against the right tag. Returns the input length when
// the archive is truncated mid-element, so the partial content is still shown.
function findCloseTagStart(xml: string, tagName: string, from: number): number {
  const closeTag = `</${tagName}>`
  let depth = 0
  let cursor = from

  for (;;) {
    const nextClose = xml.indexOf(closeTag, cursor)
    if (nextClose === -1) {
      return xml.length
    }
    const nextOpen = findOpenTagStart(xml, tagName, cursor)
    if (nextOpen !== -1 && nextOpen < nextClose) {
      const nestedOpenTag = scanOpenTag(xml, nextOpen + tagName.length + 1)
      if (nestedOpenTag === null) {
        return xml.length
      }
      if (!nestedOpenTag.selfClosing) {
        depth += 1
      }
      cursor = nestedOpenTag.tagEnd + 1
      continue
    }
    if (depth === 0) {
      return nextClose
    }
    depth -= 1
    cursor = nextClose + closeTag.length
  }
}
