import { MAX_FILE_RANGE_READ_BYTES } from '../../../../shared/file-range-read'
import { documentResourceAccess } from '@/lib/local-file-access'
import type {
  RuntimeFileOperationArgs,
  RuntimeFileReadArgs
} from '@/runtime/runtime-file-client-types'
import { readRuntimeFileRange, statRuntimeReadTarget } from '@/runtime/runtime-file-range-client'
import { getRemoteFileArgs, hasRemoteRuntimeOwner } from '@/runtime/runtime-file-routing'
import { resolveImageAbsolutePath } from './markdown-preview-links'
import type { GltfResourceReader } from './gltf-model-parse'

// Why: matches the local previewable-binary cap, so one .gltf cannot buffer more than a .glb.
const MAX_GLTF_RESOURCE_BYTES = 50 * 1024 * 1024

function resourceReadArgs(
  context: RuntimeFileOperationArgs,
  documentPath: string,
  absolutePath: string
): RuntimeFileReadArgs {
  const remote = getRemoteFileArgs(context, absolutePath)
  if (!remote && hasRemoteRuntimeOwner(context)) {
    throw new Error('glTF resource is outside the owning runtime worktree')
  }
  return {
    target: context.target,
    filePath: absolutePath,
    relativePath: remote?.relativePath,
    worktreeId: context.worktreeId ?? undefined,
    connectionId: context.connectionId,
    expectedExternalSshTargetId: context.expectedExternalSshTargetId,
    access: remote ? undefined : documentResourceAccess(documentPath)
  }
}

/** Reads the buffers and textures a `.gltf` names, through the document owner's transport. */
export function createGltfResourceReader(
  context: RuntimeFileOperationArgs,
  documentPath: string
): GltfResourceReader {
  return async (uri) => {
    const absolutePath = resolveImageAbsolutePath(uri, documentPath)
    if (!absolutePath) {
      throw new Error('glTF resource is not a local file')
    }
    const args = resourceReadArgs(context, documentPath, absolutePath)
    const { size, isDirectory } = await statRuntimeReadTarget(args)
    if (isDirectory || size > MAX_GLTF_RESOURCE_BYTES) {
      throw new Error('glTF resource is not a readable file')
    }
    const bytes = new Uint8Array(size)
    for (let offset = 0; offset < size;) {
      const chunk = await readRuntimeFileRange(
        args,
        offset,
        Math.min(MAX_FILE_RANGE_READ_BYTES, size - offset)
      )
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    return bytes
  }
}
