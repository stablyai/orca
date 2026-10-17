/** Browser-only; self-contained so the native diagram document can embed the same function. */
export function readableMermaidFlowchartSvg(
  sanitizedSvg: string,
  foreground: string,
  background: string
): string {
  function luminance(color: string): number | null {
    let channels: number[]
    const hex = /^#([\da-f]{6})$/i.exec(color)
    const rgb = /^rgba?\(([\d.,\s]+)\)$/i.exec(color)
    if (hex) {
      channels = [0, 2, 4].map((offset) => Number.parseInt(hex[1].slice(offset, offset + 2), 16))
    } else if (rgb) {
      channels = rgb[1]
        .trim()
        .split(/[,\s]+/)
        .map(Number)
      if (channels.length === 4 && channels.pop() !== 1) {
        return null
      }
      if (channels.length !== 3) {
        return null
      }
    } else {
      return null
    }
    if (channels.some((value) => !Number.isFinite(value) || value < 0 || value > 255)) {
      return null
    }
    const linear = channels.map((channel) => {
      const value = channel / 255
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    })
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
  }
  function contrast(a: number, b: number): number {
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  }
  const first = luminance(foreground)
  const second = luminance(background)
  if (first === null || second === null || !sanitizedSvg.includes('flowchart')) {
    return sanitizedSvg
  }
  const host = document.createElement('div')
  host.style.display = 'none'
  // Only sanitized renderer output enters this temporary measurement DOM.
  host.innerHTML = sanitizedSvg
  document.body.appendChild(host)
  try {
    const nodes = host.querySelectorAll(
      'svg[aria-roledescription^="flowchart"] .node, svg[aria-roledescription^="flowchart"] .cluster'
    )
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index]
      const shape = node.querySelector('.label-container, rect, polygon, circle, ellipse, path')
      if (!shape) {
        continue
      }
      const style = getComputedStyle(shape)
      const fill = luminance(style.fill)
      if (
        fill === null ||
        Number.parseFloat(style.fillOpacity) < 1 ||
        Number.parseFloat(style.opacity) < 1
      ) {
        continue
      }
      const useFirst = contrast(first, fill) >= contrast(second, fill)
      const replacement = useFirst ? foreground : background
      if (contrast(useFirst ? first : second, fill) < 4.5) {
        continue
      }
      const labels = node.querySelectorAll<SVGElement | HTMLElement>(
        'text, tspan, .nodeLabel, .nodeLabel *'
      )
      for (let at = 0; at < labels.length; at++) {
        const label = labels[at]
        if (label.closest('.node, .cluster') !== node) {
          continue
        }
        const svgText = label.localName === 'text' || label.localName === 'tspan'
        const current = luminance(
          svgText ? getComputedStyle(label).fill : getComputedStyle(label).color
        )
        if (current !== null && contrast(current, fill) < 4.5) {
          if (svgText) {
            label.style.setProperty('fill', replacement, 'important')
          }
          label.style.setProperty('color', replacement, 'important')
        }
      }
    }
    return host.innerHTML
  } finally {
    host.remove()
  }
}
