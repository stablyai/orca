import { type AnimationClip, LoadingManager, type Object3D } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import {
  GLTF_DRACO_EXTENSION,
  GLTF_MESHOPT_EXTENSION,
  type GltfModelData,
  gltfExternalUris,
  gltfUsesExtension,
  readGltfDocument
} from './gltf-document-inspection'
import type { DracoDecoderHandle } from './glb-draco-decoder'

export type GltfModel = {
  scene: Object3D
  animations: AnimationClip[]
}

/** Reads a resource a `.gltf` names by relative URI; rejects when it cannot be read. */
export type GltfResourceReader = (uri: string) => Promise<Uint8Array<ArrayBuffer>>

// Why: an unresolved URI must not reach the network or the filesystem behind the reader's back.
const BLOCKED_RESOURCE_URL = 'data:,'

async function readExternalResources(
  uris: string[],
  readResource: GltfResourceReader | undefined
): Promise<Map<string, string>> {
  const urls = new Map<string, string>()
  if (!readResource) {
    return urls
  }
  const results = await Promise.allSettled(uris.map((uri) => readResource(uri)))
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      urls.set(uris[index], URL.createObjectURL(new Blob([result.value])))
    }
  })
  return urls
}

export async function parseGltfModel(
  data: GltfModelData,
  readResource?: GltfResourceReader
): Promise<GltfModel> {
  const document = readGltfDocument(data)
  if (!document) {
    throw new Error('Not a glTF document')
  }
  const resourceUrls = await readExternalResources(gltfExternalUris(document), readResource)
  let draco: DracoDecoderHandle | null = null
  try {
    const manager = new LoadingManager()
    manager.setURLModifier((url) =>
      url.startsWith('blob:') || url.startsWith('data:')
        ? url
        : (resourceUrls.get(url) ?? BLOCKED_RESOURCE_URL)
    )
    const loader = new GLTFLoader(manager)
    if (gltfUsesExtension(document, GLTF_DRACO_EXTENSION)) {
      draco = (await import('./glb-draco-decoder')).createDracoDecoder()
      loader.setDRACOLoader(draco.loader)
    }
    if (gltfUsesExtension(document, GLTF_MESHOPT_EXTENSION)) {
      const { MeshoptDecoder } = await import('three/examples/jsm/libs/meshopt_decoder.module.js')
      loader.setMeshoptDecoder(MeshoptDecoder)
    }
    return await new Promise<GltfModel>((resolve, reject) => {
      loader.parse(
        data,
        '',
        (gltf) => resolve({ scene: gltf.scene, animations: gltf.animations }),
        reject
      )
    })
  } finally {
    draco?.dispose()
    for (const url of resourceUrls.values()) {
      URL.revokeObjectURL(url)
    }
  }
}
