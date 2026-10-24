const SVG_NS = 'http://www.w3.org/2000/svg'

// Static shapes, paint servers and clipping only; anything else is removed with its subtree.
const ALLOWED_ELEMENTS = new Set([
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

const ALLOWED_ATTRIBUTES = new Set([
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

const PAINT_ATTRIBUTES = ['fill', 'stroke', 'stop-color', 'color']

// Why: a url() may only name a fragment in the same icon (a gradient, clip path or mask).
function isSafeAttributeValue(value: string): boolean {
  const urls = value.match(/url\s*\(([^)]*)\)/gi) ?? []
  return (
    !/javascript:|expression\s*\(|[<>]/i.test(value) &&
    urls.every((url) => /^url\(\s*#[A-Za-z_][\w.-]*\s*\)$/i.test(url))
  )
}

export type SanitizedPluginIcon = {
  svg: string
  /** Drawn with only currentColor, so it can take the surrounding text color as a mask. */
  monochrome: boolean
}

/** Parses an SVG with the browser's XML parser and keeps only allowlisted elements and
 *  un-namespaced attributes; returns null when the document is not a single SVG. */
export function sanitizePluginIconSvg(source: string): SanitizedPluginIcon | null {
  const document = new DOMParser().parseFromString(source, 'image/svg+xml')
  const root = document.documentElement
  if (
    document.getElementsByTagName('parsererror').length > 0 ||
    root.namespaceURI !== SVG_NS ||
    root.localName !== 'svg'
  ) {
    return null
  }
  const paints = new Set<string>()
  const visit = (element: Element): void => {
    // Why copies: removing nodes mutates the live collections.
    for (const child of Array.from(element.children)) {
      if (child.namespaceURI !== SVG_NS || !ALLOWED_ELEMENTS.has(child.localName)) {
        child.remove()
      } else {
        visit(child)
      }
    }
    for (const attribute of Array.from(element.attributes)) {
      if (
        attribute.namespaceURI !== null ||
        !ALLOWED_ATTRIBUTES.has(attribute.localName) ||
        !isSafeAttributeValue(attribute.value)
      ) {
        element.removeAttributeNode(attribute)
      } else if (PAINT_ATTRIBUTES.includes(attribute.localName)) {
        paints.add(attribute.value.trim().toLowerCase())
      } else if (attribute.localName === 'style') {
        for (const match of attribute.value.matchAll(
          /(?:^|;)\s*(?:fill|stroke|stop-color|color)\s*:\s*([^;]+)/gi
        )) {
          paints.add((match[1] ?? '').trim().toLowerCase())
        }
      }
    }
  }
  visit(root)
  paints.delete('none')
  return {
    svg: new XMLSerializer().serializeToString(root),
    monochrome: paints.size === 1 && paints.has('currentcolor')
  }
}
