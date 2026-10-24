import { LoadingManager } from 'three'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import dracoWrapperSource from 'three/examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js?raw'
import dracoWasmUrl from 'three/examples/jsm/libs/draco/gltf/draco_decoder.wasm?url&inline'

const DRACO_WRAPPER_FILE = 'draco_wasm_wrapper.js'
const DRACO_WASM_FILE = 'draco_decoder.wasm'

export type DracoDecoderHandle = {
  loader: DRACOLoader
  dispose: () => void
}

// Why inline sources: packaged builds load the renderer from file://, where fetch() of a
// sibling asset is refused, but blob: and data: URLs stay fetchable.
export function createDracoDecoder(): DracoDecoderHandle {
  const wrapperUrl = URL.createObjectURL(
    new Blob([dracoWrapperSource], { type: 'text/javascript' })
  )
  const manager = new LoadingManager()
  manager.setURLModifier((url) =>
    url.endsWith(DRACO_WRAPPER_FILE)
      ? wrapperUrl
      : url.endsWith(DRACO_WASM_FILE)
        ? dracoWasmUrl
        : url
  )
  const loader = new DRACOLoader(manager)
  loader.setDecoderConfig({ type: 'wasm' })
  return {
    loader,
    dispose: () => {
      loader.dispose()
      URL.revokeObjectURL(wrapperUrl)
    }
  }
}
