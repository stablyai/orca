import { describe, expect, it } from 'vitest'
import { parseXlsxWorkbook } from './xlsx-workbook'
import { buildZipArchive } from './xlsx-workbook-test-fixtures'

// A 1x1 transparent PNG, so the fixture carries real image bytes.
const PNG_BYTES = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64'
  )
)

function buildWorkbookWithDrawing({
  anchorXml,
  mediaName = 'xl/media/image1.png',
  mediaBytes = PNG_BYTES,
  drawingRelationshipTarget = '../media/image1.png'
}: {
  anchorXml: string
  mediaName?: string
  mediaBytes?: Uint8Array
  drawingRelationshipTarget?: string
}): Uint8Array {
  return buildZipArchive([
    {
      name: 'xl/workbook.xml',
      content: '<workbook><sheets><sheet name="Pics" sheetId="1" r:id="rId1"/></sheets></workbook>'
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      content:
        '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      content:
        '<worksheet><sheetData><row r="1"><c r="A1" t="str"><v>a</v></c></row></sheetData><drawing r:id="rIdD1"/></worksheet>'
    },
    {
      name: 'xl/worksheets/_rels/sheet1.xml.rels',
      content:
        '<Relationships><Relationship Id="rIdD1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>'
    },
    { name: 'xl/drawings/drawing1.xml', content: `<xdr:wsDr>${anchorXml}</xdr:wsDr>` },
    {
      name: 'xl/drawings/_rels/drawing1.xml.rels',
      content: `<Relationships><Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${drawingRelationshipTarget}"/></Relationships>`
    },
    { name: mediaName, content: mediaBytes, stored: true }
  ])
}

const TWO_CELL_ANCHOR = `<xdr:twoCellAnchor>
  <xdr:from><xdr:col>1</xdr:col><xdr:row>2</xdr:row></xdr:from>
  <xdr:to><xdr:col>4</xdr:col><xdr:row>8</xdr:row></xdr:to>
  <xdr:pic><xdr:nvPicPr><xdr:cNvPr id="1" name="Imagen 1" descr="un logo"/></xdr:nvPicPr>
  <xdr:blipFill><a:blip r:embed="rIdImg"/></xdr:blipFill></xdr:pic>
</xdr:twoCellAnchor>`

describe('workbook images', () => {
  it('reads an anchored image as a data URL over its cell range', async () => {
    const workbook = await parseXlsxWorkbook(
      buildWorkbookWithDrawing({ anchorXml: TWO_CELL_ANCHOR })
    )

    expect(workbook.sheets[0]?.drawings).toEqual([
      {
        kind: 'image',
        source: `data:image/png;base64,${Buffer.from(PNG_BYTES).toString('base64')}`,
        fromColumn: 1,
        fromRow: 2,
        toColumn: 4,
        toRow: 8,
        description: 'un logo'
      }
    ])
  })

  it('pins a one-cell anchor to the cell it starts on', async () => {
    const workbook = await parseXlsxWorkbook(
      buildWorkbookWithDrawing({
        anchorXml: `<xdr:oneCellAnchor>
          <xdr:from><xdr:col>3</xdr:col><xdr:row>5</xdr:row></xdr:from>
          <xdr:pic><xdr:nvPicPr><xdr:cNvPr id="1" name="Imagen"/></xdr:nvPicPr>
          <xdr:blipFill><a:blip r:embed="rIdImg"/></xdr:blipFill></xdr:pic>
        </xdr:oneCellAnchor>`
      })
    )

    expect(workbook.sheets[0]?.drawings[0]).toMatchObject({
      fromColumn: 3,
      fromRow: 5,
      toColumn: 3,
      toRow: 5
    })
  })

  it('reads nothing from an empty drawing part', async () => {
    // Why: Excel leaves an empty <xdr:wsDr/> behind after a drawing is deleted,
    // which is what a workbook with no pictures actually looks like.
    const workbook = await parseXlsxWorkbook(buildWorkbookWithDrawing({ anchorXml: '' }))

    expect(workbook.sheets[0]?.drawings).toEqual([])
  })

  it('skips an anchor whose media is not an image format it can inline', async () => {
    const workbook = await parseXlsxWorkbook(
      buildWorkbookWithDrawing({
        anchorXml: TWO_CELL_ANCHOR,
        mediaName: 'xl/media/image1.emf',
        drawingRelationshipTarget: '../media/image1.emf'
      })
    )

    expect(workbook.sheets[0]?.drawings).toEqual([])
  })

  it('reads no images for a sheet with no drawing at all', async () => {
    const workbook = await parseXlsxWorkbook(
      buildZipArchive([
        {
          name: 'xl/workbook.xml',
          content:
            '<workbook><sheets><sheet name="Plain" sheetId="1" r:id="rId1"/></sheets></workbook>'
        },
        {
          name: 'xl/worksheets/sheet1.xml',
          content:
            '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>'
        }
      ])
    )

    expect(workbook.sheets[0]?.drawings).toEqual([])
  })
})

const CHART_ANCHOR = `<xdr:twoCellAnchor>
  <xdr:from><xdr:col>1</xdr:col><xdr:row>1</xdr:row></xdr:from>
  <xdr:to><xdr:col>6</xdr:col><xdr:row>12</xdr:row></xdr:to>
  <xdr:graphicFrame>
    <xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Gráfico 1"/></xdr:nvGraphicFramePr>
    <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="rIdChart"/></a:graphicData></a:graphic>
  </xdr:graphicFrame>
</xdr:twoCellAnchor>`

const CHART_PART = `<c:chartSpace><c:chart>
  <c:title><c:tx><c:rich><a:p><a:r><a:t>Saldo</a:t></a:r></a:p></c:rich></c:tx></c:title>
  <c:plotArea><c:barChart><c:barDir val="col"/>
    <c:ser>
      <c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>Importe</c:v></c:pt></c:strCache></c:strRef></c:tx>
      <c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>Inicial</c:v></c:pt><c:pt idx="1"><c:v>Final</c:v></c:pt></c:strCache></c:strRef></c:cat>
      <c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>1000</c:v></c:pt><c:pt idx="1"><c:v>1500</c:v></c:pt></c:numCache></c:numRef></c:val>
    </c:ser>
  </c:barChart></c:plotArea>
  <c:legend><c:legendPos val="b"/></c:legend>
</c:chart></c:chartSpace>`

function buildWorkbookWithChart(): Uint8Array {
  return buildZipArchive([
    {
      name: 'xl/workbook.xml',
      content:
        '<workbook><sheets><sheet name="Resumen" sheetId="1" r:id="rId1"/></sheets></workbook>'
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      content:
        '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      content:
        '<worksheet><sheetData><row r="1"><c r="A1" t="str"><v>a</v></c></row></sheetData><drawing r:id="rIdD1"/></worksheet>'
    },
    {
      name: 'xl/worksheets/_rels/sheet1.xml.rels',
      content:
        '<Relationships><Relationship Id="rIdD1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>'
    },
    { name: 'xl/drawings/drawing1.xml', content: `<xdr:wsDr>${CHART_ANCHOR}</xdr:wsDr>` },
    {
      name: 'xl/drawings/_rels/drawing1.xml.rels',
      content:
        '<Relationships><Relationship Id="rIdChart" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/></Relationships>'
    },
    { name: 'xl/charts/chart1.xml', content: CHART_PART }
  ])
}

describe('workbook charts', () => {
  it('reads a chart anchored through a graphic frame', async () => {
    const workbook = await parseXlsxWorkbook(buildWorkbookWithChart())
    const drawing = workbook.sheets[0]?.drawings[0]

    expect(drawing).toMatchObject({
      kind: 'chart',
      fromColumn: 1,
      fromRow: 1,
      toColumn: 6,
      toRow: 12,
      description: 'Gráfico 1'
    })
    expect(drawing?.kind === 'chart' && drawing.chart).toMatchObject({
      kind: 'column',
      title: 'Saldo',
      categories: ['Inicial', 'Final'],
      series: [{ name: 'Importe', values: [1000, 1500] }],
      showLegend: true
    })
  })

  it('does not confuse a chart anchor with a picture anchor', async () => {
    // Why: a graphic frame carries no blip, and a picture carries no c:chart —
    // reading the wrong one would resolve the relationship to the wrong part.
    const workbook = await parseXlsxWorkbook(buildWorkbookWithChart())

    expect(workbook.sheets[0]?.drawings.filter((d) => d.kind === 'image')).toEqual([])
  })
})
