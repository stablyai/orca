import {
  decodeHtmlAttributeCharacterReferences,
  decodeHtmlTextCharacterReferences,
  type HtmlAttributeQuote
} from './html-character-reference-decoder'

export const HTML_SUPERSCRIPT_LINK_SOURCE_LIMIT = 16 * 1024
export const HTML_SUPERSCRIPT_LINK_HREF_LIMIT = 8 * 1024
export const HTML_SUPERSCRIPT_LINK_TEXT_LIMIT = 2 * 1024

export type HtmlSuperscriptLinkSource = {
  source: string
  href: string
  label: string
  title: string | null
}

export type HtmlSuperscriptLinkMatch = {
  end: number
  value: HtmlSuperscriptLinkSource
}

export type HtmlSuperscriptLinkParseStats = {
  transitions: number
}

type ParsedAttribute = {
  name: 'href' | 'title'
  rawValue: string
  quote: HtmlAttributeQuote
}

const encoder = new TextEncoder()

export function matchHtmlSuperscriptLinkSource(
  input: string,
  start = 0,
  stats?: HtmlSuperscriptLinkParseStats
): HtmlSuperscriptLinkMatch | null {
  const limit = Math.min(input.length, start + HTML_SUPERSCRIPT_LINK_SOURCE_LIMIT + 1)
  let index = matchSimpleTag(input, start, 'sup', false, limit, stats)
  if (index === null) {
    return null
  }

  const anchor = matchAnchorStart(input, index, limit, stats)
  if (!anchor) {
    return null
  }
  index = anchor.end

  const labelStart = index
  while (index < limit) {
    step(stats)
    const code = input.charCodeAt(index)
    if (code === 60 || code === 10 || code === 13) {
      break
    }
    index += 1
  }
  if (index === labelStart || index >= limit || input.charCodeAt(index) !== 60) {
    return null
  }
  const rawLabel = input.slice(labelStart, index)
  index = matchSimpleTag(input, index, 'a', true, limit, stats) ?? -1
  if (index < 0) {
    return null
  }
  index = matchSimpleTag(input, index, 'sup', true, limit, stats) ?? -1
  if (index < 0 || index - start > HTML_SUPERSCRIPT_LINK_SOURCE_LIMIT) {
    return null
  }

  const hrefAttribute = anchor.attributes.find((attribute) => attribute.name === 'href')
  const titleAttribute = anchor.attributes.find((attribute) => attribute.name === 'title')
  if (!hrefAttribute) {
    return null
  }

  const href = decodeHtmlAttributeCharacterReferences(hrefAttribute.rawValue, hrefAttribute.quote)
  const label = decodeHtmlTextCharacterReferences(rawLabel)
  const title = titleAttribute
    ? decodeHtmlAttributeCharacterReferences(titleAttribute.rawValue, titleAttribute.quote)
    : null
  const source = input.slice(start, index)
  if (
    byteLength(source) > HTML_SUPERSCRIPT_LINK_SOURCE_LIMIT ||
    byteLength(href) > HTML_SUPERSCRIPT_LINK_HREF_LIMIT ||
    byteLength(label) > HTML_SUPERSCRIPT_LINK_TEXT_LIMIT ||
    (title !== null && byteLength(title) > HTML_SUPERSCRIPT_LINK_TEXT_LIMIT)
  ) {
    return null
  }

  return { end: index, value: { source, href, label, title } }
}

export function parseHtmlSuperscriptLinkSource(source: string): HtmlSuperscriptLinkSource | null {
  const match = matchHtmlSuperscriptLinkSource(source)
  return match?.end === source.length ? match.value : null
}

function matchAnchorStart(
  input: string,
  start: number,
  limit: number,
  stats?: HtmlSuperscriptLinkParseStats
): { end: number; attributes: ParsedAttribute[] } | null {
  let index = start
  if (input.charCodeAt(index) !== 60 || lowerCode(input.charCodeAt(index + 1)) !== 97) {
    return null
  }
  step(stats, 2)
  index += 2
  if (!isSingleLineHtmlWhitespace(input.charCodeAt(index))) {
    return null
  }

  const attributes: ParsedAttribute[] = []
  while (index < limit) {
    const whitespaceStart = index
    while (isSingleLineHtmlWhitespace(input.charCodeAt(index))) {
      step(stats)
      index += 1
    }
    if (input.charCodeAt(index) === 62) {
      step(stats)
      return attributes.some((attribute) => attribute.name === 'href')
        ? { end: index + 1, attributes }
        : null
    }
    if (index === whitespaceStart) {
      return null
    }

    const nameStart = index
    while (isAttributeNameCode(input.charCodeAt(index))) {
      step(stats)
      index += 1
    }
    if (index === nameStart) {
      return null
    }
    const normalizedName = input.slice(nameStart, index).toLowerCase()
    if (normalizedName !== 'href' && normalizedName !== 'title') {
      return null
    }
    if (attributes.some((attribute) => attribute.name === normalizedName)) {
      return null
    }
    while (isSingleLineHtmlWhitespace(input.charCodeAt(index))) {
      step(stats)
      index += 1
    }
    if (input.charCodeAt(index) !== 61) {
      return null
    }
    step(stats)
    index += 1
    while (isSingleLineHtmlWhitespace(input.charCodeAt(index))) {
      step(stats)
      index += 1
    }

    const parsedValue = parseAttributeValue(input, index, limit, stats)
    if (!parsedValue) {
      return null
    }
    attributes.push({
      name: normalizedName,
      rawValue: parsedValue.rawValue,
      quote: parsedValue.quote
    })
    index = parsedValue.end
  }
  return null
}

function parseAttributeValue(
  input: string,
  start: number,
  limit: number,
  stats?: HtmlSuperscriptLinkParseStats
): { end: number; rawValue: string; quote: HtmlAttributeQuote } | null {
  const first = input[start]
  if (first === '"' || first === "'") {
    let index = start + 1
    while (index < limit && input[index] !== first) {
      step(stats)
      const code = input.charCodeAt(index)
      if (code === 10 || code === 13) {
        return null
      }
      index += 1
    }
    if (index >= limit) {
      return null
    }
    step(stats)
    return {
      end: index + 1,
      rawValue: input.slice(start + 1, index),
      quote: first
    }
  }

  let index = start
  while (index < limit) {
    const code = input.charCodeAt(index)
    if (isHtmlWhitespace(code) || code === 62) {
      break
    }
    step(stats)
    if (code === 34 || code === 39 || code === 60 || code === 61 || code === 96) {
      return null
    }
    index += 1
  }
  return index === start ? null : { end: index, rawValue: input.slice(start, index), quote: null }
}

function matchSimpleTag(
  input: string,
  start: number,
  name: 'a' | 'sup',
  closing: boolean,
  limit: number,
  stats?: HtmlSuperscriptLinkParseStats
): number | null {
  let index = start
  if (input.charCodeAt(index) !== 60) {
    return null
  }
  step(stats)
  index += 1
  if (closing) {
    if (input.charCodeAt(index) !== 47) {
      return null
    }
    step(stats)
    index += 1
  }
  for (let nameIndex = 0; nameIndex < name.length; nameIndex += 1) {
    step(stats)
    if (lowerCode(input.charCodeAt(index)) !== name.charCodeAt(nameIndex)) {
      return null
    }
    index += 1
  }
  while (index < limit && isSingleLineHtmlWhitespace(input.charCodeAt(index))) {
    step(stats)
    index += 1
  }
  if (input.charCodeAt(index) !== 62) {
    return null
  }
  step(stats)
  return index + 1
}

function isAttributeNameCode(code: number): boolean {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 95 ||
    code === 46 ||
    code === 58 ||
    code === 45
  )
}

function isHtmlWhitespace(code: number): boolean {
  return code === 9 || code === 10 || code === 12 || code === 13 || code === 32
}

function isSingleLineHtmlWhitespace(code: number): boolean {
  return code === 9 || code === 12 || code === 32
}

function lowerCode(code: number): number {
  return code >= 65 && code <= 90 ? code + 32 : code
}

function byteLength(value: string): number {
  return encoder.encode(value).byteLength
}

function step(stats: HtmlSuperscriptLinkParseStats | undefined, count = 1): void {
  if (stats) {
    stats.transitions += count
  }
}
