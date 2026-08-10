/**
 * Builds real .xlsx bytes for the workbook viewer tests.
 *
 * Why a builder and not a checked-in binary fixture: the parser's job is to read
 * what producers actually write, so each test needs to vary one detail of the
 * package (a missing rels part, a stored instead of deflated entry, a 1904 date
 * system) and see it through the same zip container Excel emits. A binary
 * fixture per variation would be unreviewable.
 *
 * Not shipped: this module is only imported by tests.
 */
import { deflateRawSync } from 'node:zlib'

export type ZipEntryInput = {
  name: string
  content: string | Uint8Array
  /** Stored entries exercise the uncompressed branch of the reader. */
  stored?: boolean
}

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50
const CENTRAL_DIRECTORY_ENTRY_SIGNATURE = 0x02014b50
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50
const COMPRESSION_METHOD_STORED = 0
const COMPRESSION_METHOD_DEFLATED = 8
const VERSION_NEEDED_TO_EXTRACT = 20

export function buildZipArchive(entries: ZipEntryInput[], comment = ''): Uint8Array {
  const localParts: Uint8Array[] = []
  const centralParts: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name)
    const uncompressed =
      typeof entry.content === 'string' ? new TextEncoder().encode(entry.content) : entry.content
    const stored = entry.stored === true
    const payload = stored ? uncompressed : new Uint8Array(deflateRawSync(uncompressed))
    const method = stored ? COMPRESSION_METHOD_STORED : COMPRESSION_METHOD_DEFLATED

    const localHeader = new Uint8Array(30 + name.length)
    const localView = new DataView(localHeader.buffer)
    localView.setUint32(0, LOCAL_FILE_HEADER_SIGNATURE, true)
    localView.setUint16(4, VERSION_NEEDED_TO_EXTRACT, true)
    localView.setUint16(8, method, true)
    localView.setUint32(14, 0, true)
    localView.setUint32(18, payload.length, true)
    localView.setUint32(22, uncompressed.length, true)
    localView.setUint16(26, name.length, true)
    localHeader.set(name, 30)
    localParts.push(localHeader, payload)

    const centralHeader = new Uint8Array(46 + name.length)
    const centralView = new DataView(centralHeader.buffer)
    centralView.setUint32(0, CENTRAL_DIRECTORY_ENTRY_SIGNATURE, true)
    centralView.setUint16(4, VERSION_NEEDED_TO_EXTRACT, true)
    centralView.setUint16(6, VERSION_NEEDED_TO_EXTRACT, true)
    centralView.setUint16(10, method, true)
    centralView.setUint32(20, payload.length, true)
    centralView.setUint32(24, uncompressed.length, true)
    centralView.setUint16(28, name.length, true)
    centralView.setUint32(42, offset, true)
    centralHeader.set(name, 46)
    centralParts.push(centralHeader)

    offset += localHeader.length + payload.length
  }

  const commentBytes = new TextEncoder().encode(comment)
  const centralDirectory = concatBytes(centralParts)
  const endRecord = new Uint8Array(22 + commentBytes.length)
  const endView = new DataView(endRecord.buffer)
  endView.setUint32(0, END_OF_CENTRAL_DIRECTORY_SIGNATURE, true)
  endView.setUint16(8, entries.length, true)
  endView.setUint16(10, entries.length, true)
  endView.setUint32(12, centralDirectory.length, true)
  endView.setUint32(16, offset, true)
  endView.setUint16(20, commentBytes.length, true)
  endRecord.set(commentBytes, 22)

  return concatBytes([...localParts, centralDirectory, endRecord])
}

export type WorkbookSheetInput = {
  name: string
  /** Raw `<row>` elements, so a test can write sparse or malformed sheets. */
  sheetXml: string
  hidden?: boolean
}

export type WorkbookInput = {
  sheets: WorkbookSheetInput[]
  sharedStrings?: string[]
  stylesXml?: string
  use1904DateSystem?: boolean
  /** Omits `xl/_rels/workbook.xml.rels`, as minimal writers do. */
  omitWorkbookRels?: boolean
}

export function buildXlsxWorkbook({
  sheets,
  sharedStrings,
  stylesXml,
  use1904DateSystem,
  omitWorkbookRels
}: WorkbookInput): Uint8Array {
  const entries: ZipEntryInput[] = [
    { name: '[Content_Types].xml', content: '<Types/>' },
    { name: '_rels/.rels', content: buildPackageRelationships() },
    {
      name: 'xl/workbook.xml',
      content: buildWorkbookXml(sheets, use1904DateSystem === true)
    },
    ...sheets.map((sheet, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      content: buildWorksheetXml(sheet.sheetXml)
    }))
  ]

  if (omitWorkbookRels !== true) {
    entries.push({
      name: 'xl/_rels/workbook.xml.rels',
      content: buildWorkbookRelationships(sheets.length)
    })
  }
  if (sharedStrings) {
    entries.push({
      name: 'xl/sharedStrings.xml',
      content: buildSharedStringsXml(sharedStrings)
    })
  }
  if (stylesXml !== undefined) {
    entries.push({ name: 'xl/styles.xml', content: stylesXml })
  }

  return buildZipArchive(entries)
}

function buildPackageRelationships(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
}

function buildWorkbookRelationships(sheetCount: number): string {
  const relationships = Array.from(
    { length: sheetCount },
    (_, index) =>
      `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
  ).join('')
  return `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`
}

function buildWorkbookXml(sheets: WorkbookSheetInput[], use1904DateSystem: boolean): string {
  const sheetElements = sheets
    .map(
      (sheet, index) =>
        `<sheet name="${sheet.name}" sheetId="${index + 1}"${sheet.hidden === true ? ' state="hidden"' : ''} r:id="rId${index + 1}"/>`
    )
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${
    use1904DateSystem ? '<workbookPr date1904="1"/>' : ''
  }<sheets>${sheetElements}</sheets></workbook>`
}

function buildWorksheetXml(rowsXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<worksheet><sheetData>${rowsXml}</sheetData></worksheet>`
}

function buildSharedStringsXml(sharedStrings: string[]): string {
  const items = sharedStrings.map((value) => `<si><t>${escapeXmlText(value)}</t></si>`).join('')
  return `<?xml version="1.0" encoding="UTF-8"?><sst count="${sharedStrings.length}">${items}</sst>`
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const merged = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    merged.set(part, offset)
    offset += part.length
  }
  return merged
}
