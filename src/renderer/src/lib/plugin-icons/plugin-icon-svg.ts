import {
  isSafePluginIconAttributeValue,
  pluginIconSvgMonochromeError,
  PLUGIN_ICON_SVG_ATTRIBUTES,
  PLUGIN_ICON_SVG_ELEMENTS,
  type PluginIconSvgNode
} from '../../../../shared/plugins/contributions/plugin-panel-icon'

const SVG_NS = 'http://www.w3.org/2000/svg'

function paintNode(element: Element): PluginIconSvgNode {
  return {
    name: element.localName,
    attributes: Object.fromEntries(
      Array.from(element.attributes, (attribute) => [attribute.localName, attribute.value])
    ),
    children: Array.from(element.children, paintNode)
  }
}

export type SanitizedPluginIcon = {
  svg: string
  /** Drawn with only currentColor, so it can take the surrounding text color as a mask. */
  monochrome: boolean
}

/** Parses an SVG with the browser's XML parser and keeps only allowlisted elements and
 *  un-namespaced attributes; returns null when the document is not a single SVG. */
export function sanitizePluginIconSvg(source: string): SanitizedPluginIcon | null {
  let document = new DOMParser().parseFromString(source, 'image/svg+xml')
  // Why: inline-style SVGs often omit xmlns, which HTML tolerates but the XML parser does not.
  if (document.documentElement.namespaceURI === null) {
    document = new DOMParser().parseFromString(
      source.replace(/<svg(?=[\s>/])/, `<svg xmlns="${SVG_NS}"`),
      'image/svg+xml'
    )
  }
  const root = document.documentElement
  if (
    document.getElementsByTagName('parsererror').length > 0 ||
    root.namespaceURI !== SVG_NS ||
    root.localName !== 'svg'
  ) {
    return null
  }
  const visit = (element: Element): void => {
    // Why copies: removing nodes mutates the live collections.
    for (const child of Array.from(element.children)) {
      if (child.namespaceURI !== SVG_NS || !PLUGIN_ICON_SVG_ELEMENTS.has(child.localName)) {
        child.remove()
      } else {
        visit(child)
      }
    }
    for (const attribute of Array.from(element.attributes)) {
      if (
        attribute.namespaceURI !== null ||
        !PLUGIN_ICON_SVG_ATTRIBUTES.has(attribute.localName) ||
        !isSafePluginIconAttributeValue(attribute.value)
      ) {
        element.removeAttributeNode(attribute)
      }
    }
  }
  visit(root)
  return {
    svg: new XMLSerializer().serializeToString(root),
    monochrome: pluginIconSvgMonochromeError(paintNode(root)) === null
  }
}
