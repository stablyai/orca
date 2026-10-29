const READABLE_CONTRAST = 4.5

/** WCAG relative luminance of a `#rrggbb` or opaque `rgb()` colour; null for anything else. */
function luminance(color: string): number | null {
  const hex = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(color)
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(color)
  const channels = hex
    ? hex.slice(1).map((channel) => Number.parseInt(channel, 16))
    : rgb
      ? rgb[1].split(/[\s,/]+/).map(Number)
      : null
  if (!channels || (channels.length === 4 && channels.pop() !== 1) || channels.length !== 3) {
    return null
  }
  const [r, g, b] = channels.map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/**
 * Mermaid draws every flowchart label in the theme's text colour, so a custom fill from `style`
 * or `classDef` can hide it (light text on a pale node in dark mode). Recolours those labels to
 * whichever of `foreground` and `background` reads better on the fill. Browser-only: the fill
 * comes from computed styles, so `svg` is parsed into the document and must already be safe
 * (sanitized, or from mermaid's strict mode).
 */
export function readableMermaidFlowchartSvg(
  svg: string,
  foreground: string,
  background: string
): string {
  const fgLum = luminance(foreground)
  const bgLum = luminance(background)
  if (!svg.includes('flowchart') || fgLum === null || bgLum === null) {
    return svg
  }
  const host = document.createElement('div')
  host.style.display = 'none'
  host.innerHTML = svg
  document.body.append(host)
  try {
    const nodes = host.querySelectorAll(
      'svg[aria-roledescription^="flowchart"] .node, svg[aria-roledescription^="flowchart"] .cluster'
    )
    for (const node of nodes) {
      // Only a node's label container sits behind its label (a brace draws beside it); stadium and
      // hand-drawn shapes make it a group around the painted shapes. A subgraph is a plain rect.
      const shape = node.classList.contains('cluster')
        ? node.querySelector('rect')
        : node.querySelector('.label-container:not(g), .label-container :not(g)')
      if (!shape) {
        continue
      }
      const shapeStyle = getComputedStyle(shape)
      const fill = luminance(shapeStyle.fill)
      // A translucent fill blends with whatever is behind it, so its colour is unknown.
      if (
        fill === null ||
        Number.parseFloat(shapeStyle.fillOpacity) < 1 ||
        Number.parseFloat(shapeStyle.opacity) < 1
      ) {
        continue
      }
      const fgRatio = contrast(fgLum, fill)
      const bgRatio = contrast(bgLum, fill)
      const best =
        fgRatio >= bgRatio
          ? { color: foreground, ratio: fgRatio }
          : { color: background, ratio: bgRatio }
      for (const label of node.querySelectorAll<SVGElement | HTMLElement>(
        'text, tspan, .nodeLabel, .nodeLabel *'
      )) {
        if (label.closest('.node, .cluster') !== node) {
          continue
        }
        const svgText = label.localName === 'text' || label.localName === 'tspan'
        const labelStyle = getComputedStyle(label)
        // HTML that paints its own background (`<mark>`) was styled against that, not the fill.
        if (!svgText && luminance(labelStyle.backgroundColor) !== null) {
          continue
        }
        const current = luminance(svgText ? labelStyle.fill : labelStyle.color)
        const ratio = current === null ? 0 : contrast(current, fill)
        if (ratio < READABLE_CONTRAST && best.ratio > ratio) {
          label.style.setProperty(svgText ? 'fill' : 'color', best.color, 'important')
        }
      }
    }
    return host.innerHTML
  } finally {
    host.remove()
  }
}
