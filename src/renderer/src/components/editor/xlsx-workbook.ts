import {
  resolveXlsxPartPath,
  resolveXlsxRelationshipTargetPath,
  resolveXlsxRelationshipsPartPath
} from './xlsx-part-paths'
import { parseXlsxCellStyles, type XlsxCellStyle } from './xlsx-cell-styles'
import { parseXlsxNumberFormats } from './xlsx-number-formats'
import { expandXlsxCellRange } from './xlsx-cell-reference'
import { parseXlsxSharedStrings } from './xlsx-shared-strings'
import {
  parseXlsxSparklineFormula,
  resolveXlsxSparkline,
  type ResolvedXlsxSparkline
} from './xlsx-sparkline'
import { parseXlsxThemePalette } from './xlsx-theme-palette'
import { readXlsxSheetDrawings, type XlsxSheetDrawing } from './xlsx-drawings'
import { parseXlsxWorksheetGrid } from './xlsx-worksheet-grid'
import { parseXlsxWorksheetLayout, type XlsxMergedRange } from './xlsx-worksheet-layout'
import { forEachXlsxXmlElement } from './xlsx-xml-elements'
import { openXlsxZipArchive, type XlsxZipArchive } from './xlsx-zip-archive'

export type XlsxSheet = {
  name: string
  /** `hidden` and `veryHidden` sheets exist in the file but are not shown by Excel. */
  hidden: boolean
  rows: string[][]
  /** Per-cell fill, text colour and bold; empty when the workbook has none. */
  styles: (XlsxCellStyle | undefined)[][]
  /** Author-set column widths in pixels, by column index. */
  columnWidths: (number | undefined)[]
  /** Author-set row heights in pixels, by row index. */
  rowHeights: (number | undefined)[]
  mergedRanges: XlsxMergedRange[]
  /** Charts and images the sheet anchors over its cells. */
  drawings: XlsxSheetDrawing[]
  /**
   * In-cell sparklines by row and column. Present only for sheets exported from
   * an application whose in-cell charts Excel cannot compute.
   */
  sparklines: (ResolvedXlsxSparkline | undefined)[][]
  maxColumns: number
  truncated: boolean
}

export type XlsxWorkbook = {
  sheets: XlsxSheet[]
}

const PACKAGE_RELATIONSHIPS_PART_PATH = '_rels/.rels'
const OFFICE_DOCUMENT_RELATIONSHIP_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument'
const SHARED_STRINGS_RELATIONSHIP_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings'
const STYLES_RELATIONSHIP_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles'
const THEME_RELATIONSHIP_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme'
const FALLBACK_WORKBOOK_PART_PATH = 'xl/workbook.xml'
const RELATIONSHIP_ID_ATTRIBUTE = 'r:id'
const EXTERNAL_TARGET_MODE = 'External'

// Why: a worksheet is rendered through a virtualized grid, so the ceiling exists
// to bound parse time and renderer memory, not the viewport. One million rows of
// a wide sheet is already several hundred MB of strings.
export const MAX_XLSX_SHEET_ROWS = 200_000

export type ParseXlsxWorkbookOptions = {
  /** Locale for number formatting; defaults to English separators. */
  locale?: string
}

export async function parseXlsxWorkbook(
  bytes: Uint8Array,
  { locale = 'en-US' }: ParseXlsxWorkbookOptions = {}
): Promise<XlsxWorkbook> {
  const archive = openXlsxZipArchive(bytes)
  const workbookPartPath = await resolveWorkbookPartPath(archive)
  const workbookXml = await archive.readPartText(workbookPartPath)
  if (workbookXml === null) {
    throw new Error('Not a valid workbook: xl/workbook.xml is missing')
  }

  const relationships = await readWorkbookRelationships(archive, workbookPartPath)
  const sharedStrings = await readSharedStrings(archive, workbookPartPath, relationships)
  const stylesXml = await readSupportingPartText(
    archive,
    workbookPartPath,
    relationships,
    STYLES_RELATIONSHIP_TYPE,
    'styles.xml'
  )
  const numberFormats = parseXlsxNumberFormats(stylesXml)
  // Why: one theme parse per workbook — cell fills, font colours and chart series
  // all resolve their named colours against the same palette.
  const themePalette = parseXlsxThemePalette(
    stylesXml === ''
      ? ''
      : await readSupportingPartText(
          archive,
          workbookPartPath,
          relationships,
          THEME_RELATIONSHIP_TYPE,
          'theme/theme1.xml'
        )
  )
  const cellStyles = parseXlsxCellStyles(stylesXml, themePalette)
  const use1904DateSystem = readUse1904DateSystem(workbookXml)

  const sheets: XlsxSheet[] = []
  const descriptors = readSheetDescriptors(workbookXml)
  for (const [index, descriptor] of descriptors.entries()) {
    // Why: fall back to the conventional worksheet name when the relationship is
    // missing — hand-written and minimal-writer workbooks often omit the rels
    // part, and an empty grid would look like a data-loss bug to the reader.
    const worksheetPartPath =
      relationships.byId.get(descriptor.relationshipId) ??
      resolveXlsxPartPath(workbookPartPath, `worksheets/sheet${index + 1}.xml`)
    const worksheetXml = await archive.readPartText(worksheetPartPath)
    // Why: collecting the numbers behind every cell is only worth it when the sheet
    // actually carries a sparkline, so the cheap text probe gates it.
    const hasSparklines = (worksheetXml ?? '').includes('SPARKLINE(')
    const grid = parseXlsxWorksheetGrid(worksheetXml ?? '', {
      collectSparklines: hasSparklines,
      sharedStrings,
      numberFormats,
      cellStyles,
      use1904DateSystem,
      maxRows: MAX_XLSX_SHEET_ROWS,
      locale
    })
    const layout = parseXlsxWorksheetLayout(worksheetXml ?? '')
    const drawings = await readXlsxSheetDrawings(
      archive,
      worksheetPartPath,
      worksheetXml ?? '',
      themePalette,
      locale
    )
    sheets.push({
      name: descriptor.name,
      hidden: descriptor.hidden,
      ...grid,
      ...layout,
      drawings,
      sparklines: resolveSheetSparklines(grid)
    })
  }

  if (sheets.length === 0) {
    throw new Error('Not a valid workbook: it declares no worksheets')
  }
  return { sheets }
}

// Why: the workbook part is addressed through the package relationships rather
// than assumed at xl/workbook.xml — Excel always writes that path, but other
// producers are free to choose another one.
async function resolveWorkbookPartPath(archive: XlsxZipArchive): Promise<string> {
  const relationshipsXml = await archive.readPartText(PACKAGE_RELATIONSHIPS_PART_PATH)
  let workbookPartPath: string | null = null

  if (relationshipsXml !== null) {
    forEachXlsxXmlElement(relationshipsXml, 'Relationship', (element) => {
      const target = element.attributes.Target
      if (element.attributes.Type !== OFFICE_DOCUMENT_RELATIONSHIP_TYPE || target === undefined) {
        return
      }
      workbookPartPath = resolveXlsxRelationshipTargetPath(PACKAGE_RELATIONSHIPS_PART_PATH, target)
      return false
    })
  }

  if (workbookPartPath !== null && archive.hasPart(workbookPartPath)) {
    return workbookPartPath
  }
  return FALLBACK_WORKBOOK_PART_PATH
}

/** The workbook's relationships, indexed both by id and by relationship type. */
type XlsxWorkbookRelationships = {
  byId: Map<string, string>
  byType: Map<string, string>
}

async function readWorkbookRelationships(
  archive: XlsxZipArchive,
  workbookPartPath: string
): Promise<XlsxWorkbookRelationships> {
  const relationships: XlsxWorkbookRelationships = { byId: new Map(), byType: new Map() }
  const relationshipsPartPath = resolveXlsxRelationshipsPartPath(workbookPartPath)
  const relationshipsXml = await archive.readPartText(relationshipsPartPath)
  if (relationshipsXml === null) {
    return relationships
  }

  forEachXlsxXmlElement(relationshipsXml, 'Relationship', (element) => {
    const id = element.attributes.Id
    const target = element.attributes.Target
    // Why: an external relationship holds a URI, not a part name, so resolving it
    // as a package path would produce a part that cannot exist.
    if (
      id === undefined ||
      target === undefined ||
      element.attributes.TargetMode === EXTERNAL_TARGET_MODE
    ) {
      return
    }
    const partPath = resolveXlsxRelationshipTargetPath(relationshipsPartPath, target)
    relationships.byId.set(id, partPath)
    const type = element.attributes.Type
    if (type !== undefined && !relationships.byType.has(type)) {
      relationships.byType.set(type, partPath)
    }
  })

  return relationships
}

// Why: prefer the declared relationship over the conventional file name. A
// producer is free to name these parts anything, and guessing would silently
// lose every string or every date format.
function resolveSupportingPartPath(
  workbookPartPath: string,
  relationships: XlsxWorkbookRelationships,
  relationshipType: string,
  conventionalName: string
): string {
  return (
    relationships.byType.get(relationshipType) ??
    resolveXlsxPartPath(workbookPartPath, conventionalName)
  )
}

function resolveSheetSparklines(grid: {
  numericValues: Map<string, number>
  sparklineFormulas: Map<string, string>
}): (ResolvedXlsxSparkline | undefined)[][] {
  if (grid.sparklineFormulas.size === 0) {
    return []
  }

  const readRange = (reference: string): number[] =>
    expandXlsxCellRange(reference)
      .map((cell) => grid.numericValues.get(`${cell.rowIndex}:${cell.columnIndex}`))
      .filter((value): value is number => value !== undefined)

  const sparklines: (ResolvedXlsxSparkline | undefined)[][] = []
  for (const [key, formula] of grid.sparklineFormulas) {
    const spec = parseXlsxSparklineFormula(formula)
    if (spec === null) {
      continue
    }
    const resolved = resolveXlsxSparkline(spec, readRange)
    if (resolved === null) {
      continue
    }
    const [rowIndex, columnIndex] = key.split(':').map(Number)
    if (rowIndex === undefined || columnIndex === undefined) {
      continue
    }
    sparklines[rowIndex] ??= []
    sparklines[rowIndex]![columnIndex] = resolved
  }
  return sparklines
}

async function readSupportingPartText(
  archive: XlsxZipArchive,
  workbookPartPath: string,
  relationships: XlsxWorkbookRelationships,
  relationshipType: string,
  conventionalName: string
): Promise<string> {
  const xml = await archive.readPartText(
    resolveSupportingPartPath(workbookPartPath, relationships, relationshipType, conventionalName)
  )
  return xml ?? ''
}

async function readSharedStrings(
  archive: XlsxZipArchive,
  workbookPartPath: string,
  relationships: XlsxWorkbookRelationships
): Promise<string[]> {
  const xml = await readSupportingPartText(
    archive,
    workbookPartPath,
    relationships,
    SHARED_STRINGS_RELATIONSHIP_TYPE,
    'sharedStrings.xml'
  )
  return xml === '' ? [] : parseXlsxSharedStrings(xml)
}

// Why: workbooks saved by older Mac Excel count days from 1904-01-01 instead of
// 1900-01-01, which shifts every date by four years if ignored.
function readUse1904DateSystem(workbookXml: string): boolean {
  let use1904DateSystem = false
  forEachXlsxXmlElement(workbookXml, 'workbookPr', (element) => {
    const value = element.attributes.date1904
    use1904DateSystem = value === '1' || value === 'true'
    return false
  })
  return use1904DateSystem
}

type XlsxSheetDescriptor = {
  name: string
  hidden: boolean
  relationshipId: string
}

function readSheetDescriptors(workbookXml: string): XlsxSheetDescriptor[] {
  const descriptors: XlsxSheetDescriptor[] = []

  forEachXlsxXmlElement(workbookXml, 'sheet', (element) => {
    const state = element.attributes.state
    descriptors.push({
      name: element.attributes.name ?? '',
      hidden: state === 'hidden' || state === 'veryHidden',
      relationshipId: element.attributes[RELATIONSHIP_ID_ATTRIBUTE] ?? ''
    })
  })

  return descriptors
}
