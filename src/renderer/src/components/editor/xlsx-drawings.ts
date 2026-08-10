import { IMAGE_FILE_MIME_TYPES } from '../../../../shared/image-file-extensions'
import { resolveXlsxPartPath, resolveXlsxRelationshipsPartPath } from './xlsx-part-paths'
import { forEachXlsxXmlElement } from './xlsx-xml-elements'
import type { XlsxZipArchive } from './xlsx-zip-archive'

/**
 * An image a worksheet anchors into the grid.
 *
 * Why anchors and not pixel offsets: a spreadsheet positions a drawing by the
 * cell it starts and ends on, so the viewer places it over the same cells rather
 * than at a coordinate that would drift once column widths or zoom change.
 */
export type XlsxSheetImage = {
  /** `data:` URL, so the image survives without a second round trip. */
  source: string
  fromRow: number
  fromColumn: number
  toRow: number
  toColumn: number
  description?: string
}

// Why: a workbook can embed a lot of media, and each image is inlined as base64
// into renderer memory. Bound both the count and the size of what is inlined.
const MAX_SHEET_IMAGES = 50
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

export async function readXlsxSheetImages(
  archive: XlsxZipArchive,
  worksheetPartPath: string,
  worksheetXml: string
): Promise<XlsxSheetImage[]> {
  const drawingPartPath = await resolveDrawingPartPath(archive, worksheetPartPath, worksheetXml)
  if (drawingPartPath === null) {
    return []
  }
  const drawingXml = await archive.readPartText(drawingPartPath)
  if (drawingXml === null) {
    return []
  }
  const mediaTargets = await readDrawingImageTargets(archive, drawingPartPath)
  if (mediaTargets.size === 0) {
    return []
  }

  const images: XlsxSheetImage[] = []
  for (const anchor of readAnchors(drawingXml)) {
    if (images.length >= MAX_SHEET_IMAGES) {
      break
    }
    const partPath = mediaTargets.get(anchor.relationshipId)
    if (partPath === undefined) {
      continue
    }
    const source = await readImageDataUrl(archive, partPath)
    if (source === null) {
      continue
    }
    images.push({ ...anchor.position, description: anchor.description, source })
  }
  return images
}

async function resolveDrawingPartPath(
  archive: XlsxZipArchive,
  worksheetPartPath: string,
  worksheetXml: string
): Promise<string | null> {
  let relationshipId: string | undefined
  forEachXlsxXmlElement(worksheetXml, 'drawing', (element) => {
    relationshipId = element.attributes['r:id']
    return false
  })
  if (relationshipId === undefined) {
    return null
  }

  const relationshipsPartPath = resolveXlsxRelationshipsPartPath(worksheetPartPath)
  const relationshipsXml = await archive.readPartText(relationshipsPartPath)
  if (relationshipsXml === null) {
    return null
  }
  let target: string | undefined
  forEachXlsxXmlElement(relationshipsXml, 'Relationship', (element) => {
    if (element.attributes.Id !== relationshipId) {
      return true
    }
    target = element.attributes.Target
    return false
  })
  return target === undefined
    ? null
    : resolveXlsxPartPath(stripRelsFolder(relationshipsPartPath), target)
}

// Why: a drawing target is relative to the worksheet that owns it, not to the
// `_rels` folder its relationships file sits in.
function stripRelsFolder(relationshipsPartPath: string): string {
  const segments = relationshipsPartPath.split('/')
  const fileName = segments.pop() ?? ''
  if (segments.at(-1) === '_rels') {
    segments.pop()
  }
  return [...segments, fileName.replace(/\.rels$/, '')].join('/')
}

async function readDrawingImageTargets(
  archive: XlsxZipArchive,
  drawingPartPath: string
): Promise<Map<string, string>> {
  const targets = new Map<string, string>()
  const relationshipsPartPath = resolveXlsxRelationshipsPartPath(drawingPartPath)
  const relationshipsXml = await archive.readPartText(relationshipsPartPath)
  if (relationshipsXml === null) {
    return targets
  }

  forEachXlsxXmlElement(relationshipsXml, 'Relationship', (element) => {
    const id = element.attributes.Id
    const target = element.attributes.Target
    if (id === undefined || target === undefined) {
      return
    }
    if (element.attributes.TargetMode === 'External') {
      return
    }
    targets.set(id, resolveXlsxPartPath(stripRelsFolder(relationshipsPartPath), target))
  })

  return targets
}

type XlsxAnchor = {
  relationshipId: string
  description?: string
  position: Pick<XlsxSheetImage, 'fromRow' | 'fromColumn' | 'toRow' | 'toColumn'>
}

// Why: a twoCellAnchor spans a range, a oneCellAnchor pins a corner. Both are
// read; an absolute anchor has no cell reference at all and is skipped, since
// there is no cell to hang it on.
function readAnchors(drawingXml: string): XlsxAnchor[] {
  const anchors: XlsxAnchor[] = []

  for (const anchorTag of ['xdr:twoCellAnchor', 'xdr:oneCellAnchor'] as const) {
    forEachXlsxXmlElement(drawingXml, anchorTag, (element) => {
      const relationshipId = readBlipRelationshipId(element.inner)
      if (relationshipId === undefined) {
        return
      }
      const from = readAnchorCell(element.inner, 'xdr:from')
      const to = readAnchorCell(element.inner, 'xdr:to') ?? from
      if (from === null || to === null) {
        return
      }
      anchors.push({
        relationshipId,
        description: readAnchorDescription(element.inner),
        position: {
          fromRow: from.row,
          fromColumn: from.column,
          toRow: Math.max(from.row, to.row),
          toColumn: Math.max(from.column, to.column)
        }
      })
    })
  }

  return anchors
}

function readBlipRelationshipId(anchorXml: string): string | undefined {
  let relationshipId: string | undefined
  forEachXlsxXmlElement(anchorXml, 'a:blip', (element) => {
    relationshipId = element.attributes['r:embed']
    return false
  })
  return relationshipId
}

function readAnchorDescription(anchorXml: string): string | undefined {
  let description: string | undefined
  forEachXlsxXmlElement(anchorXml, 'xdr:cNvPr', (element) => {
    description = element.attributes.descr ?? element.attributes.name
    return false
  })
  return description
}

function readAnchorCell(
  anchorXml: string,
  tagName: string
): { row: number; column: number } | null {
  let cell: { row: number; column: number } | null = null
  forEachXlsxXmlElement(anchorXml, tagName, (element) => {
    const row = readIntegerElement(element.inner, 'xdr:row')
    const column = readIntegerElement(element.inner, 'xdr:col')
    if (row !== null && column !== null) {
      cell = { row, column }
    }
    return false
  })
  return cell
}

function readIntegerElement(xml: string, tagName: string): number | null {
  let value: number | null = null
  forEachXlsxXmlElement(xml, tagName, (element) => {
    const parsed = Number.parseInt(element.inner.trim(), 10)
    value = Number.isInteger(parsed) && parsed >= 0 ? parsed : null
    return false
  })
  return value
}

async function readImageDataUrl(archive: XlsxZipArchive, partPath: string): Promise<string | null> {
  const extension = partPath.slice(partPath.lastIndexOf('.')).toLowerCase()
  const mimeType = IMAGE_FILE_MIME_TYPES[extension]
  if (mimeType === undefined) {
    return null
  }
  const bytes = await archive.readPartBytes(partPath)
  if (bytes === null || bytes.byteLength > MAX_IMAGE_BYTES) {
    return null
  }
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return `data:${mimeType};base64,${btoa(binary)}`
}
