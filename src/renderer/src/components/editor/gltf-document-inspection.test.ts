import { describe, expect, it } from 'vitest'
import {
  GLTF_DRACO_EXTENSION,
  gltfExternalUris,
  gltfUsesExtension,
  readGltfDocument
} from './gltf-document-inspection'

function glbContainer(json: string): ArrayBuffer {
  const jsonBytes = new TextEncoder().encode(json.padEnd(Math.ceil(json.length / 4) * 4, ' '))
  const buffer = new ArrayBuffer(20 + jsonBytes.length)
  const view = new DataView(buffer)
  view.setUint32(0, 0x46546c67, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, buffer.byteLength, true)
  view.setUint32(12, jsonBytes.length, true)
  view.setUint32(16, 0x4e4f534a, true)
  new Uint8Array(buffer, 20).set(jsonBytes)
  return buffer
}

describe('readGltfDocument', () => {
  it('reads the JSON chunk of a GLB and the text of a .gltf alike', () => {
    const json = JSON.stringify({ asset: { version: '2.0' } })
    expect(readGltfDocument(glbContainer(json))).toEqual({ asset: { version: '2.0' } })
    expect(readGltfDocument(json)).toEqual({ asset: { version: '2.0' } })
  })

  it('rejects bytes that are not a GLB and text that is not a JSON object', () => {
    expect(readGltfDocument(new TextEncoder().encode('not a model at all').buffer)).toBeNull()
    expect(readGltfDocument('[1, 2]')).toBeNull()
    expect(readGltfDocument('{ broken')).toBeNull()
  })
})

describe('glTF document inspection', () => {
  it('lists each external buffer and image once, skipping embedded data URIs', () => {
    const document = {
      buffers: [{ uri: 'mesh.bin' }, { uri: 'data:application/octet-stream;base64,AAAA' }],
      images: [{ uri: 'textures/albedo%20map.png' }, { uri: 'mesh.bin' }, { bufferView: 0 }]
    }
    expect(gltfExternalUris(document)).toEqual(['mesh.bin', 'textures/albedo%20map.png'])
  })

  it('detects Draco from either the used or the required extension list', () => {
    expect(
      gltfUsesExtension({ extensionsUsed: [GLTF_DRACO_EXTENSION] }, GLTF_DRACO_EXTENSION)
    ).toBe(true)
    expect(
      gltfUsesExtension({ extensionsRequired: [GLTF_DRACO_EXTENSION] }, GLTF_DRACO_EXTENSION)
    ).toBe(true)
    expect(gltfUsesExtension({ extensionsUsed: 'nope' }, GLTF_DRACO_EXTENSION)).toBe(false)
  })
})
