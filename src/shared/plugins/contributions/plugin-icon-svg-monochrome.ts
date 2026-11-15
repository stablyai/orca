const PAINT_ATTRIBUTES = ['fill', 'stroke', 'stop-color', 'color'] as const
const PAINTED_SHAPES = new Set([
  'path',
  'rect',
  'circle',
  'ellipse',
  'polygon',
  'polyline',
  'text',
  'use'
])
const PAINT_SERVER_ELEMENTS = new Set(['defs', 'clipPath', 'mask'])

/** A sanitized or validated SVG element, in the shape the monochrome check needs. */
export type PluginIconSvgNode = {
  name: string
  attributes: Record<string, string>
  children: PluginIconSvgNode[]
}

export const PLUGIN_ICON_MONOCHROME_ERROR =
  'SVG must be monochrome: every fill and stroke must be currentColor or none, and every painted shape must set its own fill'

function declaredFill(node: PluginIconSvgNode): string | null {
  const style = node.attributes.style?.match(/(?:^|;)\s*fill\s*:\s*([^;]+)/i)?.[1]
  return style?.trim() ?? node.attributes.fill ?? null
}

function paintValues(node: PluginIconSvgNode): string[] {
  const values = PAINT_ATTRIBUTES.flatMap((name) => {
    const value = node.attributes[name]
    return value === undefined ? [] : [value.trim().toLowerCase()]
  })
  for (const match of node.attributes.style?.matchAll(
    /(?:^|;)\s*(?:fill|stroke|stop-color|color)\s*:\s*([^;]+)/gi
  ) ?? []) {
    values.push((match[1] ?? '').trim().toLowerCase())
  }
  return values
}

/** Why shared: authoring validation and the renderer must agree on what draws as one mask. */
export function pluginIconSvgMonochromeError(root: PluginIconSvgNode): string | null {
  const paints = new Set<string>()
  let defaultFill = false
  const visit = (node: PluginIconSvgNode, inheritedFill: boolean, paintServer: boolean): void => {
    const fill = declaredFill(node)
    for (const paint of paintValues(node)) {
      paints.add(paint)
    }
    const inPaintServer = paintServer || PAINT_SERVER_ELEMENTS.has(node.name)
    if (PAINTED_SHAPES.has(node.name) && !inPaintServer && !inheritedFill && fill === null) {
      defaultFill = true
    }
    for (const child of node.children) {
      visit(child, inheritedFill || fill !== null, inPaintServer)
    }
  }
  visit(root, false, false)
  paints.delete('none')
  return paints.size === 1 && paints.has('currentcolor') && !defaultFill
    ? null
    : PLUGIN_ICON_MONOCHROME_ERROR
}
