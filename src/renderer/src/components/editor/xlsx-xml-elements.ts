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
    const openTagEnd = xml.indexOf('>', openTagStart)
    if (openTagEnd === -1) {
      return
    }

    const attributesEnd = xml.charCodeAt(openTagEnd - 1) === SLASH ? openTagEnd - 1 : openTagEnd
    const attributes = parseXlsxXmlAttributes(
      xml.slice(openTagStart + tagName.length + 1, attributesEnd)
    )
    if (attributesEnd !== openTagEnd) {
      if (visit({ attributes, inner: '' }) === false) {
        return
      }
      cursor = openTagEnd + 1
      continue
    }

    const innerStart = openTagEnd + 1
    const innerEnd = findCloseTagStart(xml, tagName, innerStart)
    if (visit({ attributes, inner: xml.slice(innerStart, innerEnd) }) === false) {
      return
    }
    cursor = innerEnd + tagName.length + 3
  }
}

/** Concatenates the text of every `<t>` element, the SpreadsheetML text run. */
export function readXlsxXmlTextRuns(xml: string): string {
  let text = ''
  forEachXlsxXmlElement(xml, 't', (element) => {
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
      const nextOpenEnd = xml.indexOf('>', nextOpen)
      if (nextOpenEnd === -1) {
        return xml.length
      }
      if (xml.charCodeAt(nextOpenEnd - 1) !== SLASH) {
        depth += 1
      }
      cursor = nextOpenEnd + 1
      continue
    }
    if (depth === 0) {
      return nextClose
    }
    depth -= 1
    cursor = nextClose + closeTag.length
  }
}
