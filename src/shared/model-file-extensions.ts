export const GLB_MIME_TYPE = 'model/gltf-binary'

export function isGltfFilePath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.gltf')
}

export const MODEL_FILE_MIME_TYPES: Record<string, string> = {
  '.glb': GLB_MIME_TYPE
}
