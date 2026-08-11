import { describe, expect, it } from 'vitest'
import { parseXlsxChart } from './xlsx-chart'
import { readSeries } from './xlsx-chart-series'
import { parseXlsxThemePalette } from './xlsx-theme-palette'

const THEME = parseXlsxThemePalette(
  '<a:clrScheme><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2></a:clrScheme>'
)

function points(list: (string | number | null)[]): string {
  return list
    .map((value, index) =>
      value === null ? '' : `<c:pt idx="${index}"><c:v>${value}</c:v></c:pt>`
    )
    .join('')
}

function numericCache(tagName: string, values: (number | null)[]): string {
  return `<${tagName}><c:numRef><c:numCache><c:formatCode>General</c:formatCode>${points(values)}</c:numCache></c:numRef></${tagName}>`
}

function series({
  name,
  values,
  categories,
  fill = '<a:solidFill><a:schemeClr val="accent1"/></a:solidFill>',
  valueTag = 'c:val',
  positions,
  marker,
  extra = ''
}: {
  name: string
  values: (number | null)[]
  categories?: string[]
  fill?: string
  valueTag?: string
  positions?: (number | null)[]
  marker?: string
  extra?: string
}): string {
  return `<c:ser>
    <c:idx val="0"/><c:order val="0"/>
    <c:tx><c:strRef><c:f>Hoja1!$B$1</c:f><c:strCache><c:pt idx="0"><c:v>${name}</c:v></c:pt></c:strCache></c:strRef></c:tx>
    <c:spPr>${fill}</c:spPr>
    ${marker === undefined ? '' : `<c:marker><c:symbol val="${marker}"/></c:marker>`}
    ${categories === undefined ? '' : `<c:cat><c:strRef><c:strCache>${points(categories)}</c:strCache></c:strRef></c:cat>`}
    ${positions === undefined ? '' : numericCache('c:xVal', positions)}
    ${numericCache(valueTag, values)}
    ${extra}
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
      series: [
        {
          kind: 'column',
          name: 'Previsto',
          color: '#4472c4',
          values: [950, 1450]
        }
      ],
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

  it('formats a date axis through the code cached beside it', () => {
    // Why: Excel caches a date axis as serials with its format code; ignoring the
    // code put 46168 on the axis where the file says 26-5.
    const xml = chartXml(
      `<c:areaChart><c:ser>
        <c:cat><c:numRef><c:numCache><c:formatCode>d\\-m</c:formatCode><c:pt idx="0"><c:v>46168</c:v></c:pt><c:pt idx="1"><c:v>46175</c:v></c:pt></c:numCache></c:numRef></c:cat>
        <c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>176</c:v></c:pt><c:pt idx="1"><c:v>176</c:v></c:pt></c:numCache></c:numRef></c:val>
      </c:ser></c:areaChart>`
    )

    expect(parseXlsxChart(xml, THEME, { locale: 'es-ES' })?.categories).toEqual(['26-5', '2-6'])
  })

  it('leaves a plain numeric axis as its numbers', () => {
    const xml = chartXml(
      `<c:barChart><c:ser>
        <c:cat><c:numRef><c:numCache><c:formatCode>General</c:formatCode><c:pt idx="0"><c:v>10</c:v></c:pt></c:numCache></c:numRef></c:cat>
        <c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>1</c:v></c:pt></c:numCache></c:numRef></c:val>
      </c:ser></c:barChart>`
    )

    expect(parseXlsxChart(xml, THEME)?.categories).toEqual(['10'])
  })

  it('reads a gradient fill, which is what an area series usually carries', () => {
    const xml = chartXml(
      `<c:areaChart>${series({
        name: 'Sombreado',
        values: [1],
        fill: '<a:gradFill><a:gsLst><a:gs pos="19000"><a:schemeClr val="accent2"/></a:gs><a:gs pos="100000"><a:srgbClr val="F7B02B"/></a:gs></a:gsLst></a:gsLst></a:gradFill>'
      })}</c:areaChart>`
    )

    expect(parseXlsxChart(xml, THEME)?.series[0]?.gradient).toEqual([
      { position: 0.19, color: '#ed7d31' },
      { position: 1, color: '#f7b02b' }
    ])
  })

  it('ignores a gradient with a single stop, which cannot be one', () => {
    const xml = chartXml(
      `<c:areaChart>${series({
        name: 'S',
        values: [1],
        fill: '<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs></a:gsLst></a:gradFill>'
      })}</c:areaChart>`
    )

    expect(parseXlsxChart(xml, THEME)?.series[0]?.gradient).toBeUndefined()
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

const PROGRESS_DATES = [
  46168, 46175, 46182, 46189, 46196, 46203, 46210, 46217, 46224, 46231, 46238, 46245
]
const PROGRESS_WEIGHTS = [
  176, 176, 177.6, 177.2, 176.8, 176.4, 175.9, 175.5, 175, 174.4, 173.8, 173.2
]

describe('parseXlsxChart with overlaid plots', () => {
  it('reads the series of every plot in the plot area, each tagged with its own kind', () => {
    const xml = chartXml(
      `<c:areaChart>${series({ name: 'Sombreado', values: [176, 177] })}</c:areaChart>
       <c:scatterChart>${series({ name: 'Objetivo', values: [172, 172], valueTag: 'c:yVal' })}</c:scatterChart>`
    )
    const chart = parseXlsxChart(xml, THEME)

    expect(chart?.series.map((entry) => entry.kind)).toEqual(['area', 'scatter'])
    expect(chart?.series.map((entry) => entry.name)).toEqual(['Sombreado', 'Objetivo'])
    expect(chart?.series.map((entry) => entry.values)).toEqual([
      [176, 177],
      [172, 172]
    ])
  })

  it('takes the chart kind from the first plot in the document, not the last', () => {
    const xml = chartXml(
      `<c:areaChart>${series({ name: 'A', values: [1] })}</c:areaChart>
       <c:scatterChart>${series({ name: 'B', values: [2], valueTag: 'c:yVal' })}</c:scatterChart>`
    )
    const chart = parseXlsxChart(xml, THEME)

    expect(chart?.kind).toBe('area')
    expect(chart?.declaredType).toBe('c:areaChart')
  })

  it('orders the plots by their position in the document, not by the lookup order', () => {
    const xml = chartXml(
      `<c:scatterChart>${series({ name: 'B', values: [2], valueTag: 'c:yVal' })}</c:scatterChart>
       <c:areaChart>${series({ name: 'A', values: [1] })}</c:areaChart>`
    )
    const chart = parseXlsxChart(xml, THEME)

    expect(chart?.kind).toBe('scatter')
    expect(chart?.declaredType).toBe('c:scatterChart')
    expect(chart?.series.map((entry) => entry.name)).toEqual(['B', 'A'])
  })

  it('reads a bar plot overlaid with a line plot as both kinds', () => {
    const xml = chartXml(
      `<c:barChart><c:barDir val="col"/>${series({ name: 'Sesiones', values: [3, 4] })}</c:barChart>
       <c:lineChart>${series({ name: 'Media', values: [3.5, 3.5] })}</c:lineChart>`
    )

    expect(parseXlsxChart(xml, THEME)?.series.map((entry) => entry.kind)).toEqual([
      'column',
      'line'
    ])
  })

  it('reads the supported plot and takes no series from an unsupported neighbour', () => {
    const xml = chartXml(
      `<c:barChart>${series({ name: 'Real', values: [1] })}</c:barChart>
       <c:radarChart>${series({ name: 'Radar', values: [9] })}</c:radarChart>`
    )
    const chart = parseXlsxChart(xml, THEME)

    expect(chart?.kind).toBe('column')
    expect(chart?.series.map((entry) => entry.name)).toEqual(['Real'])
  })

  it('plots nothing when every plot in the area is unsupported', () => {
    const xml = chartXml(
      `<c:radarChart>${series({ name: 'Radar', values: [9] })}</c:radarChart>
       <c:bubbleChart>${series({ name: 'Burbujas', values: [8] })}</c:bubbleChart>`
    )
    const chart = parseXlsxChart(xml, THEME)

    expect(chart?.kind).toBeNull()
    expect(chart?.series).toEqual([])
  })

  it('borrows the categories from a later plot when the first plot declares none', () => {
    const xml = chartXml(
      `<c:areaChart>${series({ name: 'Sombreado', values: [176, 177] })}</c:areaChart>
       <c:lineChart>${series({ name: 'Peso', values: [172, 172], categories: ['May', 'Jun'] })}</c:lineChart>`
    )

    expect(parseXlsxChart(xml, THEME)?.categories).toEqual(['May', 'Jun'])
  })

  it('caps the series at the chart limit across every plot, not per plot', () => {
    const many = (count: number, prefix: string): string =>
      Array.from({ length: count }, (_unused, index) =>
        series({ name: `${prefix}${index}`, values: [index] })
      ).join('')
    const xml = chartXml(
      `<c:barChart>${many(20, 'bar')}</c:barChart><c:lineChart>${many(20, 'line')}</c:lineChart>`
    )
    const chart = parseXlsxChart(xml, THEME)

    expect(chart?.series).toHaveLength(24)
    expect(chart?.series.filter((entry) => entry.kind === 'line')).toHaveLength(4)
  })

  it('reads the progress chart of a weight workbook as an area under two scatter series', () => {
    const xml = chartXml(
      `<c:areaChart><c:grouping val="standard"/>${series({
        name: 'Sombreado de progreso',
        values: PROGRESS_WEIGHTS,
        fill: '<a:gradFill><a:gsLst><a:gs pos="19000"><a:srgbClr val="42BAC3"/></a:gs><a:gs pos="100000"><a:srgbClr val="F7B02B"/></a:gs></a:gsLst></a:gradFill>'
      })}</c:areaChart>
       <c:scatterChart><c:scatterStyle val="lineMarker"/>
         ${series({
           name: 'Progreso',
           values: PROGRESS_WEIGHTS,
           valueTag: 'c:yVal',
           positions: PROGRESS_DATES,
           marker: 'circle',
           fill: '<a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>'
         })}
         ${series({
           name: 'Peso objetivo',
           values: [172, 172],
           valueTag: 'c:yVal',
           positions: [46168, 46245],
           marker: 'none',
           fill: '<a:solidFill><a:srgbClr val="F7B02B"/></a:solidFill>'
         })}
       </c:scatterChart>`
    )
    const chart = parseXlsxChart(xml, THEME)

    expect(chart?.kind).toBe('area')
    expect(chart?.series).toHaveLength(3)
    expect(chart?.series[0]).toMatchObject({
      kind: 'area',
      name: 'Sombreado de progreso',
      values: PROGRESS_WEIGHTS
    })
    expect(chart?.series[0]?.showsLine).toBeUndefined()
    expect(chart?.series[0]?.positions).toBeUndefined()
    expect(chart?.series[1]).toEqual({
      kind: 'scatter',
      name: 'Progreso',
      color: '#ffffff',
      values: PROGRESS_WEIGHTS,
      positions: PROGRESS_DATES,
      showsLine: true,
      showsMarkers: true
    })
    expect(chart?.series[2]).toEqual({
      kind: 'scatter',
      name: 'Peso objetivo',
      color: '#f7b02b',
      values: [172, 172],
      positions: [46168, 46245],
      showsLine: true,
      showsMarkers: false
    })
  })
})

describe('parseXlsxChart scatter line style', () => {
  it.each([
    ['marker', false],
    ['lineMarker', true],
    ['smoothMarker', true],
    ['line', true]
  ])('reads scatterStyle %s as showsLine %s', (style, showsLine) => {
    const xml = chartXml(
      `<c:scatterChart><c:scatterStyle val="${style}"/>${series({
        name: 'S',
        values: [1, 2],
        valueTag: 'c:yVal'
      })}</c:scatterChart>`
    )

    expect(parseXlsxChart(xml, THEME)?.series[0]?.showsLine).toBe(showsLine)
  })

  it('joins the points of a scatter plot that declares no style', () => {
    const xml = chartXml(
      `<c:scatterChart>${series({ name: 'S', values: [1, 2], valueTag: 'c:yVal' })}</c:scatterChart>`
    )

    expect(parseXlsxChart(xml, THEME)?.series[0]?.showsLine).toBe(true)
  })

  it.each(['c:areaChart', 'c:barChart'])('leaves showsLine unset for %s', (element) => {
    const xml = chartXml(`<${element}>${series({ name: 'S', values: [1, 2] })}</${element}>`)

    expect(parseXlsxChart(xml, THEME)?.series[0]?.showsLine).toBeUndefined()
  })
})

describe('readSeries', () => {
  const read = (plotXml: string): ReturnType<typeof readSeries> => readSeries(plotXml, THEME)

  it('reads the values of a category series from c:val', () => {
    expect(read(series({ name: 'S', values: [10, 20] }))[0]?.values).toEqual([10, 20])
  })

  it('reads the values of a scatter series from c:yVal', () => {
    expect(read(series({ name: 'S', values: [172, 172], valueTag: 'c:yVal' }))[0]?.values).toEqual([
      172, 172
    ])
  })

  it('prefers c:val over c:yVal when a series carries both', () => {
    const xml = series({
      name: 'S',
      values: [1, 2],
      extra: numericCache('c:yVal', [90, 91])
    })

    expect(read(xml)[0]?.values).toEqual([1, 2])
  })

  it('reads the x positions a scatter series declares in c:xVal', () => {
    const xml = series({
      name: 'S',
      values: [172, 172],
      valueTag: 'c:yVal',
      positions: [46168, 46245]
    })

    expect(read(xml)[0]?.positions).toEqual([46168, 46245])
  })

  it('leaves the positions unset for a series with no c:xVal', () => {
    expect(read(series({ name: 'S', values: [1, 2] }))[0]?.positions).toBeUndefined()
  })

  it('leaves the positions unset for an empty c:xVal rather than reporting no points', () => {
    const xml = series({
      name: 'S',
      values: [1, 2],
      valueTag: 'c:yVal',
      positions: []
    })

    expect(read(xml)[0]?.positions).toBeUndefined()
  })

  it('places the positions by their point index, leaving a gap as null', () => {
    const xml = series({
      name: 'S',
      values: [172, null, 172],
      valueTag: 'c:yVal',
      positions: [46168, null, 46245]
    })

    expect(read(xml)[0]?.positions).toEqual([46168, null, 46245])
  })

  it.each([
    ['none', false],
    ['circle', true],
    ['square', true]
  ])('reads the marker symbol %s as showsMarkers %s', (marker, showsMarkers) => {
    expect(read(series({ name: 'S', values: [1], marker }))[0]?.showsMarkers).toBe(showsMarkers)
  })

  it('leaves showsMarkers unset for a series with no marker element', () => {
    expect(read(series({ name: 'S', values: [1] }))[0]?.showsMarkers).toBeUndefined()
  })

  it('reads every series of a plot in document order', () => {
    const xml = `${series({ name: 'Primera', values: [1] })}${series({ name: 'Segunda', values: [2] })}`

    expect(read(xml).map((entry) => entry.name)).toEqual(['Primera', 'Segunda'])
  })
})
