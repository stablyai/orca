const GLB_MAGIC = 0x46546c67
const GLB_JSON_CHUNK_TYPE = 0x4e4f534a
const GLB_HEADER_BYTES = 12
const GLB_CHUNK_HEADER_BYTES = 8

export const GLTF_DRACO_EXTENSION = 'KHR_draco_mesh_compression'
export const GLTF_MESHOPT_EXTENSION = 'EXT_meshopt_compression'

export type GltfModelData = ArrayBuffer | string

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readGlbJsonText(data: ArrayBuffer): string | null {
  if (data.byteLength < GLB_HEADER_BYTES + GLB_CHUNK_HEADER_BYTES) {
    return null
  }
  const view = new DataView(data)
  if (view.getUint32(0, true) !== GLB_MAGIC) {
    return null
  }
  const chunkLength = view.getUint32(GLB_HEADER_BYTES, true)
  const chunkType = view.getUint32(GLB_HEADER_BYTES + 4, true)
  const chunkStart = GLB_HEADER_BYTES + GLB_CHUNK_HEADER_BYTES
  if (chunkType !== GLB_JSON_CHUNK_TYPE || chunkStart + chunkLength > data.byteLength) {
    return null
  }
  return new TextDecoder().decode(new Uint8Array(data, chunkStart, chunkLength))
}

/** The glTF JSON document of a `.gltf` text or a `.glb` container, or null when unreadable. */
export function readGltfDocument(data: GltfModelData): Record<string, unknown> | null {
  const text = typeof data === 'string' ? data : readGlbJsonText(data)
  if (text === null) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

export function gltfUsesExtension(document: Record<string, unknown>, extension: string): boolean {
  return (
    stringList(document.extensionsUsed).includes(extension) ||
    stringList(document.extensionsRequired).includes(extension)
  )
}

/** Buffer and image URIs that point outside the document (not `data:` URIs). */
export function gltfExternalUris(document: Record<string, unknown>): string[] {
  const uris = new Set<string>()
  for (const key of ['buffers', 'images']) {
    const entries = document[key]
    if (!Array.isArray(entries)) {
      continue
    }
    for (const entry of entries) {
      if (isRecord(entry) && typeof entry.uri === 'string' && !entry.uri.startsWith('data:')) {
        uris.add(entry.uri)
      }
    }
  }
  return [...uris]
}
