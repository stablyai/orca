import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SpreadsheetChart } from './SpreadsheetChart'
import type { XlsxChart } from './xlsx-chart'

function chart(overrides: Partial<XlsxChart> = {}): XlsxChart {
  return {
    kind: 'column',
    categories: ['Inicial', 'Final'],
    series: [{ name: 'Importe', color: '#4472c4', values: [1000, 1500] }],
    showLegend: true,
    hasSecondaryAxis: false,
    ...overrides
  }
}

function render(value: XlsxChart, width = 420, height = 260): string {
  return renderToStaticMarkup(<SpreadsheetChart chart={value} width={width} height={height} />)
}

describe('SpreadsheetChart', () => {
  it('draws a column per value in the series colour the file declares', () => {
    const html = render(chart())

    expect(html).toContain('<svg')
    expect((html.match(/<rect/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect(html).toContain('#4472c4')
  })

  it('gives every mark a title so identity is not colour-alone', () => {
    const html = render(chart())

    expect(html).toContain('Importe · Inicial: 1,000')
    expect(html).toContain('Importe · Final: 1,500')
  })

  it('names the chart for assistive technology', () => {
    const html = render(chart({ title: 'Saldo' }))

    expect(html).toContain('role="img"')
    expect(html).toContain('aria-label="Saldo: Importe"')
  })

  it('omits the legend for a single series and keeps it for two', () => {
    // Why: one series has one colour, so the title already says what is plotted;
    // a box with one swatch restates it and costs space.
    const single = render(chart())
    const double = render(
      chart({
        series: [
          { name: 'Previsto', values: [950, 1450] },
          { name: 'Real', values: [1000, 1500] }
        ]
      })
    )

    expect(single).not.toContain('Importe</text>')
    expect(double).toContain('Previsto</text>')
    expect(double).toContain('Real</text>')
  })

  it('does not print a value on every point', () => {
    // Why: a number beside every mark is chaos and goes unread; the axis and the
    // tooltips carry the rest. The values here deliberately do not land on an axis
    // tick, so finding one as visible text would mean it was labelled directly.
    const html = render(chart({ series: [{ name: 'S', values: [937, 1483] }] }))

    expect(html).toContain('S · Inicial: 937')
    expect(html).not.toContain('>937</text>')
    expect(html).not.toContain('>1,483</text>')
  })

  it('anchors a column baseline at zero', () => {
    const html = render(chart({ series: [{ name: 'S', values: [950, 1000] }] }))

    expect(html).toContain('>0<')
  })

  it('lets a line or area frame its own range instead of starting at zero', () => {
    // Why: a weight series between 172 and 178 drawn from zero is a flat line —
    // Excel auto-scales these forms, and matching that is what the file shows.
    for (const kind of ['line', 'area'] as const) {
      const html = render(chart({ kind, series: [{ name: 'Peso', values: [172, 178] }] }))

      expect(html).not.toContain('>0</text>')
    }
  })

  it('draws a line chart as a polyline with round caps and ringed markers', () => {
    const html = render(chart({ kind: 'line' }))

    expect(html).toContain('<polyline')
    expect(html).toContain('stroke-linecap="round"')
    expect(html).toContain('stroke-width="2"')
    expect(html).toContain('<circle')
  })

  it('draws an area as a wash under its line, not a saturated block', () => {
    const html = render(chart({ kind: 'area' }))

    expect(html).toContain('<polygon')
    expect(html).toContain('fill-opacity="0.1"')
  })

  it('draws a pie as slices separated by a surface gap', () => {
    const html = render(chart({ kind: 'pie' }))

    expect(html).toContain('<path')
    expect(html).toContain('stroke-spreadsheet-surface')
    expect(html).toContain('stroke-width="2"')
  })

  it('draws a doughnut with a hole', () => {
    const pie = render(chart({ kind: 'pie' }))
    const doughnut = render(chart({ kind: 'doughnut' }))

    expect(pie).not.toBe(doughnut)
    expect(doughnut).toContain('<path')
  })

  it('says what an unsupported chart type is instead of drawing an empty frame', () => {
    const html = render(chart({ kind: null, declaredType: 'c:radarChart', title: 'Radar' }))

    expect(html).not.toContain('<svg')
    expect(html).toContain('Radar')
    expect(html).toContain('not rendered')
  })

  it('says it is too small rather than drawing an illegible thumbnail', () => {
    const html = render(chart(), 60, 40)

    expect(html).not.toContain('<svg')
    expect(html).toContain('Too small')
  })

  it('skips a gap in a series without breaking the plot', () => {
    const html = render(chart({ series: [{ name: 'S', values: [1000, null, 1500] }] }))

    expect(html).toContain('<svg')
    expect(html).toContain('S · Inicial: 1,000')
  })

  it('renders an all-zero pie without dividing by zero', () => {
    const html = render(chart({ kind: 'pie', series: [{ name: 'S', values: [0, 0] }] }))

    expect(html).toContain('<svg')
    expect(html).not.toContain('NaN')
  })

  it('never puts a series colour on text', () => {
    // Why: a light categorical hue is illegible as text on the surface; identity
    // comes from the coloured mark beside the label.
    const html = render(chart({ title: 'Saldo' }))
    const textTags = html.match(/<text[^>]*>/g) ?? []

    expect(textTags.length).toBeGreaterThan(0)
    for (const tag of textTags) {
      expect(tag).not.toContain('#4472c4')
    }
  })
})

describe('SpreadsheetChart gradients', () => {
  it('paints an area with the gradient the file declares', () => {
    const html = render(
      chart({
        kind: 'area',
        series: [
          {
            name: 'Sombreado',
            gradient: [
              { position: 0.19, color: '#42bac3' },
              { position: 1, color: '#f7b02b' }
            ],
            values: [176, 177.6]
          }
        ]
      })
    )

    expect(html).toContain('<linearGradient')
    expect(html).toContain('#42bac3')
    expect(html).toContain('#f7b02b')
    expect(html).toContain('offset="19%"')
  })

  it('keeps the wash for an area with no gradient', () => {
    const html = render(chart({ kind: 'area' }))

    expect(html).not.toContain('<linearGradient')
    expect(html).toContain('fill-opacity="0.1"')
  })
})
