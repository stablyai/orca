export type MermaidSvgSize = {
  width: number
  height: number
}

function positiveSize(width: number, height: number): MermaidSvgSize | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null
  }
  return { width, height }
}

function sizeFromViewBoxAttr(svg: SVGSVGElement): MermaidSvgSize | null {
  const viewBoxAttr = svg.getAttribute('viewBox')
  if (!viewBoxAttr) {
    return null
  }
  const parts = viewBoxAttr
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  return parts.length === 4 ? positiveSize(parts[2], parts[3]) : null
}

export function readMermaidSvgSize(svg: SVGSVGElement): MermaidSvgSize | null {
  const fromAttr = sizeFromViewBoxAttr(svg)
  if (fromAttr) {
    return fromAttr
  }

  const viewBox = svg.viewBox?.baseVal
  if (viewBox) {
    const fromViewBox = positiveSize(viewBox.width, viewBox.height)
    if (fromViewBox) {
      return fromViewBox
    }
  }

  try {
    const box = svg.getBBox()
    const fromBox = positiveSize(box.width, box.height)
    if (fromBox) {
      return fromBox
    }
  } catch {
    // SVG is not in a rendered layout yet.
  }

  return positiveSize(svg.clientWidth, svg.clientHeight)
}

export function findMermaidSvg(root: ParentNode | null): SVGSVGElement | null {
  return root?.querySelector('svg') ?? null
}

export function mermaidDiagramCanExpand(root: ParentNode | null): boolean {
  return findMermaidSvg(root) != null && root?.querySelector('.mermaid-error') == null
}

// Why: mermaid writes fixed max-width/height onto the SVG. Zoom layout sizes a
// wrapper instead, so those inline caps have to come off or the diagram cannot
// grow past its original pixel box.
export function prepareMermaidSvgForZoom(svg: SVGSVGElement): void {
  svg.style.maxWidth = 'none'
  svg.style.width = '100%'
  svg.style.height = '100%'
  svg.removeAttribute('width')
  svg.removeAttribute('height')
  if (!svg.getAttribute('preserveAspectRatio')) {
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
  }
}
