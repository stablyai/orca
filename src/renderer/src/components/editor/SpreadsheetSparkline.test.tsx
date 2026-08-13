import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SpreadsheetSparkline } from './SpreadsheetSparkline'
import type { ResolvedXlsxSparkline } from './xlsx-sparkline'

function sparkline(overrides: Partial<ResolvedXlsxSparkline> = {}): ResolvedXlsxSparkline {
  return {
    chartType: 'column',
    values: [1000],
    min: 0,
    max: 1500,
    color: '#334960',
    ...overrides
  }
}

const render = (value: ResolvedXlsxSparkline): string =>
  renderToStaticMarkup(<SpreadsheetSparkline sparkline={value} />)

function heights(html: string): number[] {
  return [...html.matchAll(/height="([\d.]+)"/g)].map((match) => Number(match[1]))
}

describe('SpreadsheetSparkline', () => {
  it('scales a column against the bound the formula pinned, not its own cell', () => {
    // Why: the two balance columns share MAX(D17:E17). If each filled its own
    // cell they would look equal, which is the comparison the author wanted.
    const shorter = render(sparkline({ values: [1000] }))
    const taller = render(sparkline({ values: [1500] }))

    expect(heights(shorter)[0]).toBeCloseTo(200 / 3, 6)
    expect(heights(taller)[0]).toBe(100)
  })

  it('uses the colour the formula declares', () => {
    expect(render(sparkline({ color: '#f46524' }))).toContain('#f46524')
  })

  it('prefers firstcolor for the first column', () => {
    const html = render(sparkline({ color: '#aaaaaa', firstColor: '#334960' }))

    expect(html).toContain('#334960')
    expect(html).not.toContain('#aaaaaa')
  })

  it('draws a bar horizontally from the left edge', () => {
    const html = render(sparkline({ chartType: 'bar', values: [950], max: 1000 }))

    expect(html).toContain('x="0"')
    expect(html).toContain('width="95"')
  })

  it('draws a line across several values', () => {
    const html = render(sparkline({ chartType: 'line', values: [0, 750, 1500] }))

    expect(html).toContain('<polyline')
    expect(html).toContain('points="0,100 50,50 100,0"')
  })

  it('falls back to a column when a line has a single point', () => {
    const html = render(sparkline({ chartType: 'line', values: [1000] }))

    expect(html).toContain('<rect')
    expect(html).not.toContain('<polyline')
  })

  it('encodes only the sign for a win/loss plot', () => {
    const html = render(sparkline({ chartType: 'winloss', values: [5, 0, 9] }))
    const marks = heights(html)

    expect(marks[0]).toBe(marks[2])
    expect(marks[1]).toBe(0)
  })

  it('colours a negative value with the colour for it', () => {
    const html = render(sparkline({ values: [-50], min: -100, negativeColor: '#c0504d' }))

    expect(html).toContain('#c0504d')
  })

  it('clamps a value outside the declared bounds instead of overflowing', () => {
    const html = render(sparkline({ values: [3000], max: 1500 }))

    expect(heights(html)[0]).toBe(100)
    expect(html).not.toContain('NaN')
  })

  it('does not divide by zero on a flat scale', () => {
    const html = render(sparkline({ values: [0], min: 0, max: 0 }))

    expect(html).not.toContain('NaN')
  })

  it('names itself for assistive technology and each mark for hover', () => {
    const html = render(sparkline({ values: [1000] }))

    expect(html).toContain('role="img"')
    expect(html).toContain('aria-label="column: 1000"')
    expect(html).toContain('<title>1000</title>')
  })
})
