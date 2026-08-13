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

function countTags(html: string, tagName: string): number {
  return (html.match(new RegExp(`<${tagName}[\\s>]`, 'g')) ?? []).length
}

function polylines(html: string): { x: number; y: number }[][] {
  return [...html.matchAll(/<polyline[^>]*points="([^"]*)"/g)].map((match) =>
    match[1]!.split(' ').map((pair) => {
      const [x, y] = pair.split(',')
      return { x: Number(x), y: Number(y) }
    })
  )
}

describe('SpreadsheetChart with overlaid series', () => {
  it('draws the marks of an area series and of a scatter series laid over it', () => {
    const html = render(
      chart({
        kind: 'area',
        categories: [],
        series: [
          { kind: 'area', name: 'Sombreado', values: [176, 177, 176.5] },
          {
            kind: 'scatter',
            name: 'Objetivo',
            values: [172, 172],
            showsLine: true
          }
        ]
      })
    )

    expect(countTags(html, 'polygon')).toBe(1)
    expect(countTags(html, 'polyline')).toBe(2)
  })

  it('draws each series with the marks of its own kind, not the chart kind', () => {
    const html = render(
      chart({
        kind: 'line',
        showLegend: false,
        categories: [],
        series: [
          { kind: 'column', name: 'Sesiones', values: [3, 4] },
          { kind: 'line', name: 'Media', values: [3.5, 3.5] }
        ]
      })
    )

    expect(countTags(html, 'rect')).toBe(2)
    expect(countTags(html, 'polyline')).toBe(1)
  })

  it('draws markers only for the series that asks for them', () => {
    const html = render(
      chart({
        kind: 'line',
        categories: [],
        series: [
          {
            kind: 'line',
            name: 'Progreso',
            values: [176, 177, 176.5],
            showsMarkers: true
          },
          {
            kind: 'scatter',
            name: 'Objetivo',
            values: [172, 172],
            showsMarkers: false
          }
        ]
      })
    )

    expect(countTags(html, 'circle')).toBe(3)
  })

  it('draws a scatter series without a line as bare markers', () => {
    const html = render(
      chart({
        kind: 'scatter',
        categories: [],
        series: [
          {
            kind: 'scatter',
            name: 'Pesadas',
            values: [176, 177],
            showsLine: false
          }
        ]
      })
    )

    expect(html).not.toContain('<polyline')
    expect(countTags(html, 'circle')).toBe(2)
  })

  it('anchors the axis at zero when any overlaid series is a column', () => {
    const html = render(
      chart({
        kind: 'line',
        series: [
          { kind: 'line', name: 'Peso', values: [172, 178] },
          { kind: 'column', name: 'Sesiones', values: [3, 4] }
        ]
      })
    )

    expect(html).toContain('>0</text>')
  })

  it('lets the axis frame its own range when every series is a line', () => {
    const html = render(
      chart({
        kind: 'column',
        series: [
          { kind: 'line', name: 'Peso', values: [172, 178] },
          { kind: 'line', name: 'Objetivo', values: [174, 174] }
        ]
      })
    )

    expect(html).not.toContain('>0</text>')
  })
})

describe('SpreadsheetChart series positions', () => {
  const spread = (count: number): number[] =>
    Array.from({ length: count }, (_unused, index) => index * 10)

  it('spans a two-point series across the plot when its positions say so', () => {
    const html = render(
      chart({
        kind: 'scatter',
        categories: [],
        series: [
          {
            kind: 'scatter',
            name: 'Progreso',
            values: spread(11).map((step) => 172 + step / 10),
            positions: spread(11),
            showsLine: true
          },
          {
            kind: 'scatter',
            name: 'Objetivo',
            values: [174, 174],
            positions: [0, 100],
            showsLine: true
          }
        ]
      })
    )
    const [progress, target] = polylines(html)

    expect(progress).toHaveLength(11)
    expect(target).toHaveLength(2)
    expect(target![0]!.x).toBeCloseTo(progress![0]!.x)
    expect(target!.at(-1)!.x).toBeCloseTo(progress!.at(-1)!.x)
    expect(target!.at(-1)!.x).toBeGreaterThan(target![0]!.x + 1)
  })

  it('keeps a series with no positions on its category steps beside one that has them', () => {
    const html = render(
      chart({
        kind: 'line',
        categories: [],
        series: [
          { kind: 'line', name: 'Peso', values: [176, 177, 178] },
          {
            kind: 'scatter',
            name: 'Objetivo',
            values: [174, 174],
            positions: [0, 100],
            showsLine: true
          }
        ]
      })
    )
    const [byIndex] = polylines(html)

    expect(html).not.toContain('NaN')
    expect(byIndex).toHaveLength(3)
    expect(byIndex![1]!.x - byIndex![0]!.x).toBeCloseTo(byIndex![2]!.x - byIndex![1]!.x)
  })

  it('spaces a chart whose series declare no positions evenly by category', () => {
    const html = render(
      chart({
        kind: 'line',
        categories: [],
        series: [{ name: 'S', values: [1, 2, 3, 4] }]
      })
    )
    const [byIndex] = polylines(html)

    expect(byIndex).toHaveLength(4)
    const steps = byIndex!.slice(1).map((point, index) => point.x - byIndex![index]!.x)
    for (const step of steps) {
      expect(step).toBeCloseTo(steps[0]!)
    }
  })

  it('falls back to category steps when every position is the same value', () => {
    const html = render(
      chart({
        kind: 'scatter',
        categories: [],
        series: [
          {
            kind: 'scatter',
            name: 'Objetivo',
            values: [172, 172],
            positions: [5, 5],
            showsLine: true
          }
        ]
      })
    )
    const [byIndex] = polylines(html)

    expect(html).not.toContain('NaN')
    expect(byIndex).toHaveLength(2)
    expect(byIndex![1]!.x).toBeGreaterThan(byIndex![0]!.x)
  })
})
