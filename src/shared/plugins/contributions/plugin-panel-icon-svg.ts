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

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  quot: '"'
}

function decodeXmlAttributeEntities(value: string): string | null {
  let decoded = ''
  let cursor = 0
  for (const match of value.matchAll(/&(?:#x([0-9a-fA-F]+)|#([0-9]+)|([A-Za-z][\w.-]*));/g)) {
    const before = value.slice(cursor, match.index)
    if (before.includes('&')) {
      return null
    }
    decoded += before
    const named = match[3]
    const codePoint = match[1]
      ? Number.parseInt(match[1], 16)
      : match[2]
        ? Number.parseInt(match[2], 10)
        : named
          ? null
          : 0
    if (named) {
      const replacement = XML_ENTITIES[named]
      if (replacement === undefined) {
        return null
      }
      decoded += replacement
    } else if (codePoint !== null && isXmlCodePoint(codePoint)) {
      decoded += String.fromCodePoint(codePoint)
    } else {
      return null
    }
    cursor = (match.index ?? 0) + match[0].length
  }
  const rest = value.slice(cursor)
  return rest.includes('&') ? null : decoded + rest
}

function isXmlCodePoint(value: number): boolean {
  return (
    value === 0x9 ||
    value === 0xa ||
    value === 0xd ||
    (value >= 0x20 && value <= 0xd7ff) ||
    (value >= 0xe000 && value <= 0xfffd) ||
    (value >= 0x10000 && value <= 0x10ffff)
  )
}

/** A url() may only name a fragment in the same icon (a gradient, clip path or mask). */
export function isSafePluginIconAttributeValue(value: string): boolean {
  const decoded = decodeXmlAttributeEntities(value)
  if (
    decoded === null ||
    /javascript:|expression\s*\(|@import|[<>]/i.test(decoded) ||
    decoded.includes('\\')
  ) {
    return false
  }
  if (/(?:https?|ftp|file|data|blob):|\/\//i.test(decoded)) {
    return false
  }
  const urls = decoded.match(/url\s*\(([^)]*)\)/gi) ?? []
  return urls.every((url) => /^url\(\s*#[A-Za-z_][\w.-]*\s*\)$/i.test(url))
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const SVG_TAG = /<(\/?)([A-Za-z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g
const SVG_ATTRIBUTE = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
const VIEW_BOX =
  /^\s*(-?(?:\d+(?:\.\d*)?|\.\d+))[\s,]+(-?(?:\d+(?:\.\d*)?|\.\d+))[\s,]+(\d+(?:\.\d*)?|\.\d+)[\s,]+(\d+(?:\.\d*)?|\.\d+)\s*$/

function svgAttributesError(attributes: string, root: boolean): string | null {
  const seen = new Set<string>()
  let cursor = 0
  let viewBox: string | undefined
  for (const match of attributes.matchAll(SVG_ATTRIBUTE)) {
    if (attributes.slice(cursor, match.index).trim() !== '') {
      return 'SVG attributes must be quoted XML attributes'
    }
    const name = match[1] ?? ''
    const value = match[2] ?? match[3] ?? ''
    if (seen.has(name)) {
      return `SVG repeats the "${name}" attribute`
    }
    seen.add(name)
    if (name === 'xmlns') {
      if (!root || value !== SVG_NS) {
        return `SVG namespace must be "${SVG_NS}"`
      }
    } else if (
      name.startsWith('xmlns:') ||
      !PLUGIN_ICON_SVG_ATTRIBUTES.has(name) ||
      !isSafePluginIconAttributeValue(value)
    ) {
      return `SVG attribute "${name}" is not allowed`
    }
    if (name === 'viewBox') {
      viewBox = value
    }
    cursor = (match.index ?? 0) + match[0].length
  }
  if (attributes.slice(cursor).trim() !== '') {
    return 'SVG attributes must be quoted XML attributes'
  }
  if (!root) {
    return null
  }
  const box = viewBox ? VIEW_BOX.exec(viewBox) : null
  const width = box ? Number(box[3]) : 0
  const height = box ? Number(box[4]) : 0
  return box && width > 0 && height > 0
    ? null
    : 'SVG must have a viewBox with positive width and height'
}

/** Strict author-time check for a panel icon SVG: one static SVG document, no scripts,
 *  event handlers, network references or foreign content. */
export function pluginPanelIconSvgError(source: string): string | null {
  const text = source.trim()
  if (/<!(?:DOCTYPE|ENTITY)\b/i.test(text)) {
    return 'SVG document types and entities are not allowed'
  }
  if (!/^(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text)) {
    return 'must be one SVG document'
  }
  const body = text.replace(/^<\?xml[\s\S]*?\?>\s*/, '').replace(/<!--[\s\S]*?-->/g, '')
  const stack: string[] = []
  let rootSeen = false
  let cursor = 0
  for (const match of body.matchAll(SVG_TAG)) {
    if (body.slice(cursor, match.index).includes('<')) {
      return 'SVG contains malformed markup'
    }
    cursor = (match.index ?? 0) + match[0].length
    const closing = match[1] === '/'
    const name = match[2] ?? ''
    const rawAttributes = match[3] ?? ''
    let attributes = rawAttributes.trim()
    if (name.includes(':')) {
      return `SVG element "${name}" is not allowed`
    }
    if (rootSeen && stack.length === 0) {
      return 'must be one complete SVG document'
    }
    if (closing) {
      if (attributes.length > 0 || stack.pop() !== name) {
        return 'SVG elements are not closed in order'
      }
      continue
    }
    if (!PLUGIN_ICON_SVG_ELEMENTS.has(name)) {
      return `SVG element "${name}" is not allowed`
    }
    const selfClosing = rawAttributes.endsWith('/')
    if (selfClosing) {
      attributes = attributes.replace(/\/\s*$/, '').trim()
    }
    if (stack.length === 0) {
      if (rootSeen || name !== 'svg') {
        return 'must contain exactly one SVG root'
      }
      rootSeen = true
    } else if (name === 'svg') {
      return 'SVG roots cannot be nested'
    }
    const attributesError = svgAttributesError(attributes, stack.length === 0)
    if (attributesError) {
      return attributesError
    }
    if (!selfClosing) {
      stack.push(name)
    }
  }
  if (!rootSeen || stack.length > 0 || body.slice(cursor).trim() !== '') {
    return 'must be one complete SVG document'
  }
  return null
}
