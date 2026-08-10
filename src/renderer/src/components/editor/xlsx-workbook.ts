import {
  resolveXlsxPartPath,
  resolveXlsxRelationshipTargetPath,
  resolveXlsxRelationshipsPartPath
} from './xlsx-part-paths'
import { parseXlsxNumberFormats, type XlsxNumberFormats } from './xlsx-number-formats'
import { parseXlsxSharedStrings } from './xlsx-shared-strings'
import { parseXlsxWorksheetGrid } from './xlsx-worksheet-grid'
import { forEachXlsxXmlElement } from './xlsx-xml-elements'
import { openXlsxZipArchive, type XlsxZipArchive } from './xlsx-zip-archive'

export type XlsxSheet = {
  name: string
  /** `hidden` and `veryHidden` sheets exist in the file but are not shown by Excel. */
  hidden: boolean
  rows: string[][]
  maxColumns: number
  truncated: boolean
}

export type XlsxWorkbook = {
  sheets: XlsxSheet[]
}

const PACKAGE_RELATIONSHIPS_PART_PATH = '_rels/.rels'
const OFFICE_DOCUMENT_RELATIONSHIP_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument'
const FALLBACK_WORKBOOK_PART_PATH = 'xl/workbook.xml'
const RELATIONSHIP_ID_ATTRIBUTE = 'r:id'

// Why: a worksheet is rendered through a virtualized grid, so the ceiling exists
// to bound parse time and renderer memory, not the viewport. One million rows of
// a wide sheet is already several hundred MB of strings.
export const MAX_XLSX_SHEET_ROWS = 200_000

export async function parseXlsxWorkbook(bytes: Uint8Array): Promise<XlsxWorkbook> {
  const archive = openXlsxZipArchive(bytes)
  const workbookPartPath = await resolveWorkbookPartPath(archive)
  const workbookXml = await archive.readPartText(workbookPartPath)
  if (workbookXml === null) {
    throw new Error('Not a valid workbook: xl/workbook.xml is missing')
  }

  const relationshipTargets = await readRelationshipTargets(archive, workbookPartPath)
  const sharedStrings = await readSharedStrings(archive, workbookPartPath)
  const numberFormats = await readNumberFormats(archive, workbookPartPath)
  const use1904DateSystem = readUse1904DateSystem(workbookXml)

  const sheets: XlsxSheet[] = []
  const descriptors = readSheetDescriptors(workbookXml)
  for (const [index, descriptor] of descriptors.entries()) {
    // Why: fall back to the conventional worksheet name when the relationship is
    // missing — hand-written and minimal-writer workbooks often omit the rels
    // part, and an empty grid would look like a data-loss bug to the reader.
    const worksheetPartPath =
      relationshipTargets.get(descriptor.relationshipId) ??
      resolveXlsxPartPath(workbookPartPath, `worksheets/sheet${index + 1}.xml`)
    const worksheetXml = await archive.readPartText(worksheetPartPath)
    const grid = parseXlsxWorksheetGrid(worksheetXml ?? '', {
      sharedStrings,
      numberFormats,
      use1904DateSystem,
      maxRows: MAX_XLSX_SHEET_ROWS
    })
    sheets.push({ name: descriptor.name, hidden: descriptor.hidden, ...grid })
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

/** Maps each relationship id to the package part path it points at. */
async function readRelationshipTargets(
  archive: XlsxZipArchive,
  workbookPartPath: string
): Promise<Map<string, string>> {
  const targets = new Map<string, string>()
  const relationshipsPartPath = resolveXlsxRelationshipsPartPath(workbookPartPath)
  const relationshipsXml = await archive.readPartText(relationshipsPartPath)
  if (relationshipsXml === null) {
    return targets
  }

  forEachXlsxXmlElement(relationshipsXml, 'Relationship', (element) => {
    const id = element.attributes.Id
    const target = element.attributes.Target
    if (id !== undefined && target !== undefined) {
      targets.set(id, resolveXlsxRelationshipTargetPath(relationshipsPartPath, target))
    }
  })

  return targets
}

async function readSharedStrings(
  archive: XlsxZipArchive,
  workbookPartPath: string
): Promise<string[]> {
  const xml = await archive.readPartText(resolveXlsxPartPath(workbookPartPath, 'sharedStrings.xml'))
  return xml === null ? [] : parseXlsxSharedStrings(xml)
}

async function readNumberFormats(
  archive: XlsxZipArchive,
  workbookPartPath: string
): Promise<XlsxNumberFormats> {
  const xml = await archive.readPartText(resolveXlsxPartPath(workbookPartPath, 'styles.xml'))
  return parseXlsxNumberFormats(xml ?? '')
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
