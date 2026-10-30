// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { readableMermaidFlowchartSvg } from './mermaid-flowchart-contrast'

function flowchart(fill: string, label: string): string {
  return (
    '<svg aria-roledescription="flowchart-v2"><g class="node">' +
    `<rect class="label-container" style="fill:${fill}"></rect>` +
    `<g class="label"><text style="fill:${label}">Node</text></g>` +
    '</g></svg>'
  )
}

function labelFill(svg: string): string {
  const host = document.createElement('div')
  host.innerHTML = svg
  return host.querySelector('text')!.style.getPropertyValue('fill')
}

describe('readableMermaidFlowchartSvg', () => {
  it('recolours a light theme label on a pale custom fill', () => {
    const svg = readableMermaidFlowchartSvg(flowchart('#fde68a', '#e0e0e0'), '#e0e0e0', '#111111')
    expect(labelFill(svg)).toBe('#111111')
  })

  it('reads the painted path when the label container is a group', () => {
    const stadium = flowchart('#1e3a8a', '#e0e0e0').replace(
      '<rect class="label-container" style="fill:#1e3a8a"></rect>',
      // The group inherits the diagram's text colour; only its path is painted.
      '<g class="label-container" style="fill:#e0e0e0"><path style="fill:#1e3a8a"></path></g>'
    )
    expect(labelFill(readableMermaidFlowchartSvg(stadium, '#e0e0e0', '#111111'))).toBe('#e0e0e0')
  })
})
