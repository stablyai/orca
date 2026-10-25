// Why: @types/three's GLTFLoader imports three/webgpu, whose @webgpu/types globals retype
// HTMLCanvasElement.getContext renderer-wide. tsconfig `paths` maps the loader here instead.
import type { AnimationClip, Group, LoadingManager } from 'three'
import type { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'

export type GLTF = {
  scene: Group
  animations: AnimationClip[]
}

type MeshoptDecoderLike = {
  supported: boolean
  ready: Promise<void>
}

export declare class GLTFLoader {
  constructor(manager?: LoadingManager)
  setDRACOLoader(loader: DRACOLoader): this
  setMeshoptDecoder(decoder: MeshoptDecoderLike): this
  parse(
    data: ArrayBuffer | string,
    path: string,
    onLoad: (gltf: GLTF) => void,
    onError?: (error: unknown) => void
  ): void
}
