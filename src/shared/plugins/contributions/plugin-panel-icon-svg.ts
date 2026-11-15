import { pluginIconSvgMonochromeError, type PluginIconSvgNode } from './plugin-icon-svg-monochrome'
import {
  decodeXmlAttributeEntities,
  isSafePluginIconAttributeValue
} from './plugin-icon-svg-attribute-safety'

/** Elements and attributes kept when an icon SVG is drawn; anything else is removed. */
export const PLUGIN_ICON_SVG_ELEMENTS = new Set([
  'svg',
  'g',
  'path',
  'circle',
  'ellipse',
  'rect',
  'line',
  'polyline',
  'polygon',
  'title',
  'desc',
  'defs',
  'clipPath',
  'mask',
  'linearGradient',
  'radialGradient',
  'stop'
])

export const PLUGIN_ICON_SVG_ATTRIBUTES = new Set([
  'id',
  'viewBox',
  'width',
  'height',
  'preserveAspectRatio',
  'version',
  'd',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'fx',
  'fy',
  'fr',
  'points',
  'transform',
  'fill',
  'fill-rule',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-opacity',
  'opacity',
  'color',
  'clip-path',
  'clip-rule',
  'mask',
  'offset',
  'stop-color',
  'stop-opacity',
  'gradientUnits',
  'gradientTransform',
  'spreadMethod',
  'clipPathUnits',
  'maskUnits',
  'maskContentUnits',
  'vector-effect',
  'shape-rendering',
  'style'
])

const SVG_NS = 'http://www.w3.org/2000/svg'
const SVG_ATTRIBUTE = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
const VIEW_BOX =
  /^\s*(-?(?:\d+(?:\.\d*)?|\.\d+))[\s,]+(-?(?:\d+(?:\.\d*)?|\.\d+))[\s,]+(\d+(?:\.\d*)?|\.\d+)[\s,]+(\d+(?:\.\d*)?|\.\d+)\s*$/
/** The only valid prolog: version 1.x, optional UTF-8 encoding, optional standalone. */
const XML_DECLARATION =
  /^<\?xml\s+version\s*=\s*(?:"1\.[0-9]+"|'1\.[0-9]+')(?:\s+encoding\s*=\s*(?:"([^"]*)"|'([^']*)'))?(?:\s+standalone\s*=\s*(?:"(?:yes|no)"|'(?:yes|no)'))?\s*\?>/

function parseSvgAttributes(
  attributes: string,
  root: boolean
): { error: string | null; values: Record<string, string> } {
  const values: Record<string, string> = {}
  const seen = new Set<string>()
  let cursor = 0
  let viewBox: string | undefined
  for (const match of attributes.matchAll(SVG_ATTRIBUTE)) {
    if (attributes.slice(cursor, match.index).trim() !== '') {
      return { error: 'SVG attributes must be quoted XML attributes', values }
    }
    const name = match[1] ?? ''
    const value = match[2] ?? match[3] ?? ''
    if (seen.has(name)) {
      return { error: `SVG repeats the "${name}" attribute`, values }
    }
    seen.add(name)
    if (name === 'xmlns') {
      if (!root || value !== SVG_NS) {
        return { error: `SVG namespace must be "${SVG_NS}"`, values }
      }
    } else if (
      name.startsWith('xmlns:') ||
      !PLUGIN_ICON_SVG_ATTRIBUTES.has(name) ||
      !isSafePluginIconAttributeValue(value)
    ) {
      return { error: `SVG attribute "${name}" is not allowed`, values }
    }
    values[name] = decodeXmlAttributeEntities(value) ?? value
    if (name === 'viewBox') {
      viewBox = value
    }
    cursor = (match.index ?? 0) + match[0].length
  }
  if (attributes.slice(cursor).trim() !== '') {
    return { error: 'SVG attributes must be quoted XML attributes', values }
  }
  if (!root) {
    return { error: null, values }
  }
  const box = viewBox ? VIEW_BOX.exec(viewBox) : null
  const width = box ? Number(box[3]) : 0
  const height = box ? Number(box[4]) : 0
  return {
    error:
      box && width > 0 && height > 0
        ? null
        : 'SVG must have a viewBox with positive width and height',
    values
  }
}

/** Index of the `>` that ends a tag, ignoring quoted attribute values; -1 when unclosed. */
function svgTagEnd(source: string, start: number): number {
  let quote: string | null = null
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]
    if (quote) {
      if (character === quote) {
        quote = null
      }
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (character === '>') {
      return index
    }
  }
  return -1
}

/** Strict author-time check for a panel icon SVG: one static SVG document, no scripts,
 *  event handlers, network references or foreign content. */
export function pluginPanelIconSvgError(source: string): string | null {
  const text = source.trim()
  if (/<!(?:DOCTYPE|ENTITY)\b/i.test(text)) {
    return 'SVG document types and entities are not allowed'
  }
  let body = text
  if (body.startsWith('<?')) {
    if (!/^<\?xml(?:\s|\?>)/.test(body)) {
      return 'SVG processing instructions are not allowed'
    }
    const declaration = XML_DECLARATION.exec(body)
    if (!declaration) {
      return 'SVG XML declarations may only set version, encoding and standalone'
    }
    const encoding = declaration[1] ?? declaration[2]
    if (encoding !== undefined && !/^utf-8$/i.test(encoding)) {
      return 'SVG XML declarations must use UTF-8 encoding'
    }
    body = body.slice(declaration[0].length)
  }
  if (body.includes('<?')) {
    return 'SVG processing instructions are not allowed'
  }
  const stack: { name: string; node: PluginIconSvgNode }[] = []
  let root: PluginIconSvgNode | null = null
  let cursor = 0
  while (cursor < body.length) {
    const tagStart = body.indexOf('<', cursor)
    const textBeforeTag = body.slice(cursor, tagStart === -1 ? body.length : tagStart)
    if (textBeforeTag.trim() !== '' && stack.length === 0) {
      return 'must be one complete SVG document'
    }
    if (tagStart === -1) {
      break
    }
    if (body.startsWith('<!--', tagStart)) {
      const commentEnd = body.indexOf('-->', tagStart + 4)
      if (commentEnd === -1) {
        return 'SVG contains malformed markup'
      }
      cursor = commentEnd + 3
      continue
    }
    if (root && stack.length === 0) {
      return 'must be one complete SVG document'
    }
    const end = svgTagEnd(body, tagStart + 1)
    if (end === -1) {
      return 'SVG contains malformed markup'
    }
    const tag = body.slice(tagStart + 1, end)
    cursor = end + 1
    const closing = tag.startsWith('/')
    const content = closing ? tag.slice(1) : tag
    const nameMatch = /^([A-Za-z][\w:.-]*)/.exec(content)
    if (!nameMatch) {
      return 'SVG contains malformed markup'
    }
    const name = nameMatch[1] ?? ''
    let rawAttributes = content.slice(nameMatch[0].length)
    if (name.includes(':')) {
      return `SVG element "${name}" is not allowed`
    }
    if (closing) {
      if (rawAttributes.trim() !== '' || stack.pop()?.name !== name) {
        return 'SVG elements are not closed in order'
      }
      continue
    }
    if (!PLUGIN_ICON_SVG_ELEMENTS.has(name)) {
      return `SVG element "${name}" is not allowed`
    }
    const selfClosing = rawAttributes.trimEnd().endsWith('/')
    rawAttributes = selfClosing
      ? rawAttributes.trimEnd().replace(/\/$/, '').trim()
      : rawAttributes.trim()
    if (stack.length === 0) {
      if (root || name !== 'svg') {
        return 'must contain exactly one SVG root'
      }
    } else if (name === 'svg') {
      return 'SVG roots cannot be nested'
    }
    const parsed = parseSvgAttributes(rawAttributes, stack.length === 0)
    if (parsed.error) {
      return parsed.error
    }
    const node: PluginIconSvgNode = { name, attributes: parsed.values, children: [] }
    if (stack.length === 0) {
      root = node
    } else {
      stack.at(-1)?.node.children.push(node)
    }
    if (!selfClosing) {
      stack.push({ name, node })
    }
  }
  if (!root || stack.length > 0) {
    return 'must be one complete SVG document'
  }
  return pluginIconSvgMonochromeError(root)
}
