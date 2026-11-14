// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { GitHistoryItemViewModel } from '../../../../../../shared/git/history/git-history-graph'
import { GitHistoryGraphSvg } from './git-history-graph-svg'

const node = (id: string) => ({ id, color: 'git-graph-lane-1' as const })
function draw(viewModel: GitHistoryItemViewModel, visibleWidth?: number) {
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(
    <GitHistoryGraphSvg viewModel={viewModel} visibleWidth={visibleWidth} />
  )
  return host
}
const paths = (host: HTMLElement) =>
  Array.from(host.querySelectorAll('path'), (path) => path.getAttribute('d'))
const wide: GitHistoryItemViewModel = {
  historyItem: { id: 'current', parentIds: ['parent'], subject: '', message: '' },
  inputSwimlanes: [node('current'), ...Array.from({ length: 23 }, (_, i) => node(`lane-${i}`))],
  outputSwimlanes: [node('parent'), ...Array.from({ length: 23 }, (_, i) => node(`lane-${i}`))],
  kind: 'node'
}

it('preserves converging arcs whose strokes enter the graph column', () => {
  const view: GitHistoryItemViewModel = {
    ...wide,
    historyItem: { ...wide.historyItem, parentIds: [] },
    inputSwimlanes: [
      ...Array.from({ length: 11 }, (_, i) => node(`lane-${i}`)),
      node('current'),
      node('tail')
    ],
    outputSwimlanes: [...Array.from({ length: 11 }, (_, i) => node(`lane-${i}`)), node('tail')]
  }
  expect(paths(draw(view, 131.5))).toContain(
    'M 143 0 V 6 A 5 5 0 0 1 138 12 H 137 A 5 5 0 0 0 132 17 V 24'
  )
})

it('keeps off-column merge connections and uses the last duplicate parent lane color', () => {
  const view: GitHistoryItemViewModel = {
    ...wide,
    historyItem: { ...wide.historyItem, parentIds: ['parent', 'side'] },
    outputSwimlanes: [
      ...wide.outputSwimlanes,
      node('side'),
      { id: 'side', color: 'git-graph-lane-2' }
    ]
  }
  const host = draw(view, 132)
  const merge = Array.from(host.querySelectorAll('path')).find(
    (path) => path.getAttribute('d') === 'M 275 12 A 11 11 0 0 1 286 24 M 275 12 H 11'
  )
  expect(merge?.getAttribute('stroke')).toBe('var(--git-graph-lane-2)')
})

it('keeps partially clipped HEAD and boundary rings until their complete stroke is outside', () => {
  const view: GitHistoryItemViewModel = {
    historyItem: { id: 'current', parentIds: [], subject: '', message: '' },
    inputSwimlanes: [...Array.from({ length: 12 }, (_, i) => node(`lane-${i}`)), node('current')],
    outputSwimlanes: [],
    kind: 'HEAD'
  }
  expect(draw(view, 135.75).querySelector('circle[r="6.5"]')?.getAttribute('cx')).toBe('143')
  expect(draw(view, 135.74).querySelector('circle')).toBeNull()
  const boundary = { ...view, kind: 'incoming-changes' as const }
  expect(draw(boundary, 135.75).querySelector('circle[stroke-dasharray]')).not.toBeNull()
  expect(draw(boundary).querySelector('circle[stroke-dasharray]')).not.toBeNull()
  expect(draw(boundary, 135.74).querySelector('circle')).toBeNull()
})
