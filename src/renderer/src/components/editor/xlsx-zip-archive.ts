/**
 * Minimal read-only ZIP reader for the OPC container an .xlsx/.xlsm file is
 * packaged as.
 *
 * Why hand-rolled: a workbook only needs random access to a handful of named
 * parts (workbook.xml, sharedStrings.xml, one worksheet at a time), all of
 * which are either stored or raw-deflated. That is a small, fully specified
 * slice of the ZIP format, and inflating through the platform's
 * `DecompressionStream` keeps it dependency-free — the same reasoning behind
 * the hand-rolled CSV parser in csv-parse.ts.
 */
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50
const CENTRAL_DIRECTORY_ENTRY_SIGNATURE = 0x02014b50
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50
const END_OF_CENTRAL_DIRECTORY_MIN_SIZE = 22
const MAX_END_OF_CENTRAL_DIRECTORY_COMMENT_SIZE = 0xffff
const CENTRAL_DIRECTORY_ENTRY_MIN_SIZE = 46
const LOCAL_FILE_HEADER_MIN_SIZE = 30
const ZIP64_SIZE_MARKER = 0xffffffff
const ZIP64_COUNT_MARKER = 0xffff
const COMPRESSION_METHOD_STORED = 0
const COMPRESSION_METHOD_DEFLATED = 8

type ZipArchiveEntry = {
  name: string
  compressionMethod: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

export type XlsxZipArchive = {
  /** Part names in central-directory order. */
  partNames: string[]
  hasPart(partName: string): boolean
  /** Inflates the part on demand; `null` when the archive has no such part. */
  readPartBytes(partName: string): Promise<Uint8Array | null>
  /** Same as `readPartBytes`, decoded as UTF-8. */
  readPartText(partName: string): Promise<string | null>
}

export function openXlsxZipArchive(bytes: Uint8Array): XlsxZipArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const endOffset = findEndOfCentralDirectory(view)
  if (endOffset === -1) {
    throw new Error('Not a valid workbook: the zip end-of-central-directory record is missing')
  }

  const entryCount = view.getUint16(endOffset + 10, true)
  const directorySize = view.getUint32(endOffset + 12, true)
  const directoryOffset = view.getUint32(endOffset + 16, true)
  if (
    entryCount === ZIP64_COUNT_MARKER ||
    directorySize === ZIP64_SIZE_MARKER ||
    directoryOffset === ZIP64_SIZE_MARKER
  ) {
    throw new Error('Zip64 workbooks are not supported')
  }
  if (directoryOffset + directorySize > view.byteLength) {
    throw new Error('Not a valid workbook: the zip central directory is truncated')
  }

  const entries = readCentralDirectory(bytes, view, directoryOffset, entryCount)
  return {
    partNames: [...entries.keys()],
    hasPart: (partName) => entries.has(partName),
    readPartBytes: async (partName) => {
      const entry = entries.get(partName)
      return entry ? await readEntryBytes(bytes, view, entry) : null
    },
    readPartText: async (partName) => {
      const entry = entries.get(partName)
      if (!entry) {
        return null
      }
      return new TextDecoder().decode(await readEntryBytes(bytes, view, entry))
    }
  }
}

// Why: the record is variable-length (it ends with an optional comment), so it
// has to be located by scanning backwards for its signature. Bound the scan to
// the maximum comment size instead of the whole file so a corrupt archive can't
// turn into a full-buffer scan.
function findEndOfCentralDirectory(view: DataView): number {
  if (view.byteLength < END_OF_CENTRAL_DIRECTORY_MIN_SIZE) {
    return -1
  }
  const lastPossible = view.byteLength - END_OF_CENTRAL_DIRECTORY_MIN_SIZE
  const firstPossible = Math.max(0, lastPossible - MAX_END_OF_CENTRAL_DIRECTORY_COMMENT_SIZE)
  for (let offset = lastPossible; offset >= firstPossible; offset -= 1) {
    if (view.getUint32(offset, true) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      continue
    }
    const commentLength = view.getUint16(offset + 20, true)
    if (offset + END_OF_CENTRAL_DIRECTORY_MIN_SIZE + commentLength === view.byteLength) {
      return offset
    }
  }
  return -1
}

function readCentralDirectory(
  bytes: Uint8Array,
  view: DataView,
  directoryOffset: number,
  entryCount: number
): Map<string, ZipArchiveEntry> {
  const entries = new Map<string, ZipArchiveEntry>()
  let offset = directoryOffset

  for (let index = 0; index < entryCount; index += 1) {
    if (
      offset + CENTRAL_DIRECTORY_ENTRY_MIN_SIZE > view.byteLength ||
      view.getUint32(offset, true) !== CENTRAL_DIRECTORY_ENTRY_SIGNATURE
    ) {
      throw new Error('Not a valid workbook: the zip central directory is malformed')
    }
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const nameStart = offset + CENTRAL_DIRECTORY_ENTRY_MIN_SIZE
    const name = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLength))
    // Why: directory entries carry a zero-length payload and only exist to
    // record permissions, so they would only add empty parts to the map.
    if (!name.endsWith('/')) {
      entries.set(name, {
        name,
        compressionMethod: view.getUint16(offset + 10, true),
        compressedSize: view.getUint32(offset + 20, true),
        uncompressedSize: view.getUint32(offset + 24, true),
        localHeaderOffset: view.getUint32(offset + 42, true)
      })
    }
    offset = nameStart + nameLength + extraLength + commentLength
  }

  return entries
}

async function readEntryBytes(
  bytes: Uint8Array,
  view: DataView,
  entry: ZipArchiveEntry
): Promise<Uint8Array> {
  const headerOffset = entry.localHeaderOffset
  if (
    headerOffset + LOCAL_FILE_HEADER_MIN_SIZE > view.byteLength ||
    view.getUint32(headerOffset, true) !== LOCAL_FILE_HEADER_SIGNATURE
  ) {
    throw new Error(`Not a valid workbook: ${entry.name} has no local file header`)
  }
  // Why: read the payload length from the central directory, never the local
  // header — an archive written with a streaming data descriptor (general
  // purpose bit 3) leaves the local header's sizes zeroed.
  const nameLength = view.getUint16(headerOffset + 26, true)
  const extraLength = view.getUint16(headerOffset + 28, true)
  const dataStart = headerOffset + LOCAL_FILE_HEADER_MIN_SIZE + nameLength + extraLength
  const dataEnd = dataStart + entry.compressedSize
  if (dataEnd > bytes.byteLength) {
    throw new Error(`Not a valid workbook: ${entry.name} is truncated`)
  }

  const payload = bytes.subarray(dataStart, dataEnd)
  if (entry.compressionMethod === COMPRESSION_METHOD_STORED) {
    return payload
  }
  if (entry.compressionMethod === COMPRESSION_METHOD_DEFLATED) {
    return await inflateRaw(payload)
  }
  throw new Error(`Unsupported compression method ${entry.compressionMethod} for ${entry.name}`)
}

async function inflateRaw(payload: Uint8Array): Promise<Uint8Array> {
  // Why: a stream chunk must be backed by a non-shared ArrayBuffer. Re-wrapping
  // the same memory satisfies that without copying the compressed bytes.
  const chunk = new Uint8Array(
    payload.buffer as ArrayBuffer,
    payload.byteOffset,
    payload.byteLength
  )
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(chunk)
      controller.close()
    }
  })
  const reader = source.pipeThrough(new DecompressionStream('deflate-raw')).getReader()
  const chunks: Uint8Array[] = []
  let totalLength = 0

  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    chunks.push(value)
    totalLength += value.byteLength
  }

  const inflated = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    inflated.set(chunk, offset)
    offset += chunk.byteLength
  }
  return inflated
}
