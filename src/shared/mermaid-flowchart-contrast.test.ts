// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { readableMermaidFlowchartSvg } from './mermaid-flowchart-contrast'

const palette = ['#fafafa', '#0a0a0a'] as const
function diagram(fill: string, text: string, opacity = '1'): string {
  return `<svg aria-roledescription="flowchart-v2"><g class="node"><rect class="label-container" style="fill:${fill};fill-opacity:${opacity};opacity:1"/><g class="label"><text style="fill:${text}"><tspan>Example</tspan></text></g></g></svg>`
}
it.each(['rgb(232, 245, 233)', 'rgb(255, 243, 205)', 'rgb(245, 245, 245)'])(
  'keeps a custom light node fill %s and repairs white labels',
  (fill) => {
    const before = document.body.innerHTML
    const result = readableMermaidFlowchartSvg(diagram(fill, 'rgb(250, 250, 250)'), ...palette)
    expect(result).toContain(`fill:${fill}`)
    expect(result).toContain('fill: #0a0a0a !important')
    expect(result).toContain('Example')
    expect(document.body.innerHTML).toBe(before)
  }
)
it('retains readable explicit text colors and geometry', () => {
  const svg = diagram('rgb(245, 245, 245)', 'rgb(20, 40, 60)')
  expect(readableMermaidFlowchartSvg(svg, ...palette)).not.toContain('!important')
})
it('leaves transparent, gradient and unknown fills alone', () => {
  for (const svg of [
    diagram('rgb(245, 245, 245)', 'rgb(250, 250, 250)', '0.2'),
    diagram('url(#gradient)', 'rgb(250, 250, 250)')
  ]) {
    expect(readableMermaidFlowchartSvg(svg, ...palette)).not.toContain('!important')
  }
})
it('also repairs dark nodes under a light theme', () => {
  const result = readableMermaidFlowchartSvg(
    diagram('rgb(20, 20, 20)', 'rgb(10, 10, 10)'),
    '#171717',
    '#ffffff'
  )
  expect(result).toContain('fill: #ffffff !important')
})
it('does not reinterpret other diagram families', () => {
  const svg = diagram('rgb(245, 245, 245)', 'rgb(250, 250, 250)').replace('flowchart-v2', 'er')
  expect(readableMermaidFlowchartSvg(svg, ...palette)).toBe(svg)
})

it('repairs HTML labels inside mobile foreignObjects without changing their formatting', () => {
  const svg = `<svg aria-roledescription="flowchart-v2"><g class="node"><rect class="label-container" style="fill:rgb(245, 245, 245);fill-opacity:1;opacity:1"/><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><span class="nodeLabel" style="color:rgb(250, 250, 250)"><b>Formatted</b> label</span></div></foreignObject></g></svg>`
  const result = readableMermaidFlowchartSvg(svg, ...palette)
  expect(result).toContain('color: #0a0a0a !important')
  expect(result).toContain('<b>Formatted</b> label')
})
