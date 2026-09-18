// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import {
  mermaidDiagramCanExpand,
  prepareMermaidSvgForZoom,
  readMermaidSvgSize
} from './mermaid-svg-size'

function svgFromMarkup(markup: string): SVGSVGElement {
  const container = document.createElement('div')
  container.innerHTML = markup
  const svg = container.querySelector('svg')
  if (!svg) {
    throw new Error('svg not found')
  }
  return svg
}

describe('mermaid svg size', () => {
  it('reads width and height from the viewBox attribute', () => {
    const svg = svgFromMarkup(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 400"></svg>'
    )
    expect(readMermaidSvgSize(svg)).toEqual({ width: 800, height: 400 })
  })

  it('treats a rendered svg without an error banner as expandable', () => {
    const root = document.createElement('div')
    root.innerHTML =
      '<div class="mermaid-block"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg></div>'
    expect(mermaidDiagramCanExpand(root)).toBe(true)
  })

  it('does not expand a failed mermaid fallback', () => {
    const root = document.createElement('div')
    root.innerHTML = '<div class="mermaid-block"><div class="mermaid-error">bad</div></div>'
    expect(mermaidDiagramCanExpand(root)).toBe(false)
  })

  it('clears mermaid inline size caps so zoom can grow the svg', () => {
    const svg = svgFromMarkup(
      '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400" viewBox="0 0 800 400" style="max-width: 800px; height: 400px;"></svg>'
    )
    prepareMermaidSvgForZoom(svg)
    expect(svg.getAttribute('width')).toBeNull()
    expect(svg.getAttribute('height')).toBeNull()
    expect(svg.style.maxWidth).toBe('none')
    expect(svg.style.width).toBe('100%')
    expect(svg.style.height).toBe('100%')
    expect(svg.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet')
  })
})
