// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { getRenderedDiagramSize, parseDiagramViewBoxSize } from './mermaid-diagram-size'

function renderContainer(svgMarkup: string): HTMLDivElement {
  const container = document.createElement('div')
  container.innerHTML = svgMarkup
  return container
}

describe('parseDiagramViewBoxSize', () => {
  it('reads width and height from a viewBox', () => {
    expect(parseDiagramViewBoxSize('0 0 640 480')).toEqual({ width: 640, height: 480 })
  })

  it('ignores the viewBox origin so offset diagrams keep their real size', () => {
    expect(parseDiagramViewBoxSize('-8 -8 200 100')).toEqual({ width: 200, height: 100 })
  })

  it('accepts comma-separated values', () => {
    expect(parseDiagramViewBoxSize('0,0,120,60')).toEqual({ width: 120, height: 60 })
  })

  it('rejects malformed, empty, and non-positive viewBoxes', () => {
    expect(parseDiagramViewBoxSize(null)).toBeNull()
    expect(parseDiagramViewBoxSize('')).toBeNull()
    expect(parseDiagramViewBoxSize('0 0 640')).toBeNull()
    expect(parseDiagramViewBoxSize('0 0 wide 480')).toBeNull()
    expect(parseDiagramViewBoxSize('0 0 0 480')).toBeNull()
    expect(parseDiagramViewBoxSize('0 0 -640 480')).toBeNull()
  })
})

describe('getRenderedDiagramSize', () => {
  it('prefers the viewBox over the percentage width mermaid emits by default', () => {
    const container = renderContainer(
      '<svg width="100%" style="max-width: 640px;" viewBox="0 0 640 480"></svg>'
    )

    expect(getRenderedDiagramSize(container)).toEqual({ width: 640, height: 480 })
  })

  it('falls back to px width and height attributes when useMaxWidth is off', () => {
    const container = renderContainer('<svg width="320" height="240"></svg>')

    expect(getRenderedDiagramSize(container)).toEqual({ width: 320, height: 240 })
  })

  it('returns null when only a percentage width is available', () => {
    const container = renderContainer('<svg width="100%" height="100%"></svg>')

    expect(getRenderedDiagramSize(container)).toBeNull()
  })

  it('returns null for a missing container or an unrendered diagram', () => {
    expect(getRenderedDiagramSize(null)).toBeNull()
    expect(getRenderedDiagramSize(renderContainer(''))).toBeNull()
  })
})
