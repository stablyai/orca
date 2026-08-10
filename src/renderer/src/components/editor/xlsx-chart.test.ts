import { describe, expect, it } from 'vitest'
import { parseXlsxChart } from './xlsx-chart'
import { parseXlsxThemePalette } from './xlsx-theme-palette'

const THEME = parseXlsxThemePalette(
  '<a:clrScheme><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2></a:clrScheme>'
)

function series({
  name,
  values,
  categories,
  fill = '<a:solidFill><a:schemeClr val="accent1"/></a:solidFill>'
}: {
  name: string
  values: number[]
  categories?: string[]
  fill?: string
}): string {
  const points = (list: (string | number)[]): string =>
    list.map((value, index) => `<c:pt idx="${index}"><c:v>${value}</c:v></c:pt>`).join('')
  return `<c:ser>
    <c:idx val="0"/><c:order val="0"/>
    <c:tx><c:strRef><c:f>Hoja1!$B$1</c:f><c:strCache><c:pt idx="0"><c:v>${name}</c:v></c:pt></c:strCache></c:strRef></c:tx>
    <c:spPr>${fill}</c:spPr>
    ${categories === undefined ? '' : `<c:cat><c:strRef><c:strCache>${points(categories)}</c:strCache></c:strRef></c:cat>`}
    <c:val><c:numRef><c:numCache><c:formatCode>General</c:formatCode>${points(values)}</c:numCache></c:numRef></c:val>
  </c:ser>`
}

function chartXml(plot: string, { title = '', legend = true } = {}): string {
  return `<c:chartSpace><c:chart>
    ${title === '' ? '' : `<c:title><c:tx><c:rich><a:p><a:r><a:t>${title}</a:t></a:r></a:p></c:rich></c:tx></c:title>`}
    <c:plotArea><c:layout/>${plot}<c:catAx><c:axId val="1"/></c:catAx><c:valAx><c:axId val="2"/></c:valAx></c:plotArea>
    ${legend ? '<c:legend><c:legendPos val="b"/></c:legend>' : ''}
  </c:chart></c:chartSpace>`
}

describe('parseXlsxChart', () => {
  it('reads a clustered column chart with its series, categories and title', () => {
    const xml = chartXml(
      `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>
        ${series({ name: 'Previsto', values: [950, 1450], categories: ['Gastos', 'Ganancias'] })}
      </c:barChart>`,
      { title: 'Resumen' }
    )

    expect(parseXlsxChart(xml, THEME)).toEqual({
      kind: 'column',
      declaredType: 'c:barChart',
      title: 'Resumen',
      categories: ['Gastos', 'Ganancias'],
      series: [{ name: 'Previsto', color: '#4472c4', values: [950, 1450] }],
      showLegend: true,
      hasSecondaryAxis: false
    })
  })

  it('separates a horizontal bar chart from a column chart by barDir', () => {
    const xml = chartXml(
      `<c:barChart><c:barDir val="bar"/>${series({ name: 'S', values: [1] })}</c:barChart>`
    )

    expect(parseXlsxChart(xml, THEME)?.kind).toBe('bar')
  })

  it.each([
    ['c:lineChart', 'line'],
    ['c:areaChart', 'area'],
    ['c:pieChart', 'pie'],
    ['c:doughnutChart', 'doughnut'],
    ['c:scatterChart', 'scatter']
  ])('recognizes %s', (element, kind) => {
    const xml = chartXml(`<${element}>${series({ name: 'S', values: [1, 2] })}</${element}>`)

    expect(parseXlsxChart(xml, THEME)?.kind).toBe(kind)
  })

  it('reports a plot type it cannot draw instead of an empty frame', () => {
    const xml = chartXml(`<c:radarChart>${series({ name: 'S', values: [1] })}</c:radarChart>`)
    const chart = parseXlsxChart(xml, THEME)

    expect(chart?.kind).toBeNull()
    expect(chart?.declaredType).toBe('c:radarChart')
  })

  it('reads an explicit series colour over the theme', () => {
    const xml = chartXml(
      `<c:barChart>${series({
        name: 'S',
        values: [1],
        fill: '<a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>'
      })}</c:barChart>`
    )

    expect(parseXlsxChart(xml, THEME)?.series[0]?.color).toBe('#ff0000')
  })

  it('leaves the colour unset when the series declares none', () => {
    const xml = chartXml(`<c:barChart>${series({ name: 'S', values: [1], fill: '' })}</c:barChart>`)

    expect(parseXlsxChart(xml, THEME)?.series[0]?.color).toBeUndefined()
  })

  it('places cached points by their index, not their document order', () => {
    // Why: a sparse cache lists only the points that have values, so reading them
    // in order would shift every later value onto the wrong category.
    const xml = chartXml(
      `<c:barChart><c:ser><c:val><c:numRef><c:numCache><c:pt idx="2"><c:v>30</c:v></c:pt><c:pt idx="0"><c:v>10</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:barChart>`
    )

    expect(parseXlsxChart(xml, THEME)?.series[0]?.values).toEqual([10, null, 30])
  })

  it('reads a non-numeric point as a gap', () => {
    const xml = chartXml(
      `<c:barChart><c:ser><c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>#N/A</c:v></c:pt><c:pt idx="1"><c:v>5</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:barChart>`
    )

    expect(parseXlsxChart(xml, THEME)?.series[0]?.values).toEqual([null, 5])
  })

  it('does not invent a title Excel marked as deleted', () => {
    const xml = `<c:chartSpace><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>Título 1</a:t></a:r></a:p></c:rich></c:tx></c:title><c:autoTitleDeleted val="1"/><c:plotArea><c:barChart>${series({ name: 'S', values: [1] })}</c:barChart></c:plotArea></c:chart></c:chartSpace>`

    expect(parseXlsxChart(xml, THEME)?.title).toBeUndefined()
  })

  it('reports a missing legend and a secondary value axis', () => {
    const withoutLegend = chartXml(
      `<c:barChart>${series({ name: 'S', values: [1] })}</c:barChart>`,
      { legend: false }
    )
    expect(parseXlsxChart(withoutLegend, THEME)?.showLegend).toBe(false)

    const twoAxes = `<c:chartSpace><c:chart><c:plotArea><c:barChart>${series({ name: 'S', values: [1] })}</c:barChart><c:valAx><c:axId val="1"/></c:valAx><c:valAx><c:axId val="2"/></c:valAx></c:plotArea></c:chart></c:chartSpace>`
    expect(parseXlsxChart(twoAxes, THEME)?.hasSecondaryAxis).toBe(true)
  })

  it('returns null for a part with no plot area', () => {
    expect(parseXlsxChart('<c:chartSpace/>', THEME)).toBeNull()
    expect(parseXlsxChart('', THEME)).toBeNull()
  })

  it('does not mistake the category axis for the category data', () => {
    // Why: `<c:catAx>` and `<c:cat>` share a prefix, as do `<c:valAx>` and `<c:val>`.
    const xml = chartXml(
      `<c:barChart>${series({ name: 'S', values: [7], categories: ['Uno'] })}</c:barChart>`
    )
    const chart = parseXlsxChart(xml, THEME)

    expect(chart?.categories).toEqual(['Uno'])
    expect(chart?.series[0]?.values).toEqual([7])
  })
})
