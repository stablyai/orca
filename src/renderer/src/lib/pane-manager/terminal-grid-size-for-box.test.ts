// @vitest-environment happy-dom
import { FitAddon } from '@xterm/addon-fit'
import type { Terminal } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'
import { terminalGridSizeForBox, type TerminalFitMetrics } from './terminal-grid-size-for-box'

function fitAddonResult(
  box: { width: number; height: number },
  metrics: TerminalFitMetrics
): { cols: number; rows: number } | undefined {
  const parent = document.createElement('div')
  parent.style.width = `${box.width}px`
  parent.style.height = `${box.height}px`
  const element = document.createElement('div')
  const { top, right, bottom, left } = metrics.padding
  element.style.padding = `${top}px ${right}px ${bottom}px ${left}px`
  parent.appendChild(element)
  document.body.appendChild(parent)
  const terminal = {
    element,
    dimensions: { css: { cell: metrics.cell } },
    options: { scrollback: metrics.scrollback, scrollbar: metrics.scrollbar }
  }
  const addon = new FitAddon()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: proposeDimensions reads only element, dimensions and options, all set above.
  addon.activate(terminal as unknown as Terminal)
  return addon.proposeDimensions()
}

const cases: [string, { width: number; height: number }, TerminalFitMetrics][] = [
  [
    'a fractional box with the default scrollbar',
    { width: 541.5, height: 963 },
    {
      cell: { width: 8.4, height: 16 },
      padding: { top: 0, right: 0, bottom: 0, left: 0 },
      scrollback: 5000,
      scrollbar: undefined
    }
  ],
  [
    'padding and a custom scrollbar width',
    { width: 1200, height: 700 },
    {
      cell: { width: 7.2, height: 15.5 },
      padding: { top: 2, right: 3, bottom: 4, left: 5 },
      scrollback: 1000,
      scrollbar: { width: 10 }
    }
  ],
  [
    'no scrollback, so no scrollbar',
    { width: 300, height: 200 },
    {
      cell: { width: 9, height: 18 },
      padding: { top: 0, right: 0, bottom: 0, left: 0 },
      scrollback: 0,
      scrollbar: undefined
    }
  ],
  [
    'a hidden scrollbar',
    { width: 640.9, height: 480.9 },
    {
      cell: { width: 8, height: 17 },
      padding: { top: 0, right: 0, bottom: 0, left: 0 },
      scrollback: 1000,
      scrollbar: { showScrollbar: false }
    }
  ],
  [
    'a box below the minimum grid',
    { width: 10, height: 5 },
    {
      cell: { width: 8, height: 16 },
      padding: { top: 0, right: 0, bottom: 0, left: 0 },
      scrollback: 1000,
      scrollbar: undefined
    }
  ]
]

describe('terminalGridSizeForBox', () => {
  it.each(cases)('matches FitAddon.proposeDimensions for %s', (_name, box, metrics) => {
    expect(terminalGridSizeForBox(box, metrics)).toEqual(fitAddonResult(box, metrics))
  })
})
