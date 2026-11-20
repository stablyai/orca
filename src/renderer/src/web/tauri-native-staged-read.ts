// Read a host file the renderer has no ambient access to, through the same
// authorized-external staging boundary the upload path uses. staging pins the
// file identity (size/inode/mtime) and chunk reads re-verify it, so a swapped
// file is refused rather than silently imported.

import type {
  StagedRuntimeUploadFileIdentity,
  StagedRuntimeUploadSource as StagedExternalImportSource
} from '../../../shared/file-import/runtime-upload-staging-contract'
import { invokeNative } from './tauri-native-host'

const READ_CHUNK_BYTES = 512 * 1024

type NativeFileChunk = { contentBase64: string; byteLength: number }

// Stages one path and returns the source plus the file identity a reader
// must present back to the host for every chunk.
export async function stagePath(path: string): Promise<{
  source: StagedExternalImportSource
  file?: { relativePath: string; identity: StagedRuntimeUploadFileIdentity }
}> {
  const { sources } = await invokeNative<{ sources: StagedExternalImportSource[] }>(
    'poc_stage_external_paths',
    { args: { sourcePaths: [path] } }
  )
  const source = sources[0]
  if (!source || source.status !== 'staged') {
    return { source: source ?? { sourcePath: path, status: 'failed', reason: 'not staged' } }
  }
  const file = source.entries.find(
    (entry): entry is Extract<typeof entry, { kind: 'file' }> => entry.kind === 'file'
  )
  if (!file) {
    return { source }
  }
  const { relativePath, ...identity } = file
  return { source, file: { relativePath, identity } }
}

export async function readStagedFileText(
  sourceRootPath: string,
  file: { relativePath: string; identity: StagedRuntimeUploadFileIdentity },
  maxBytes: number
): Promise<string> {
  if (file.identity.byteLength > maxBytes) {
    throw new Error(
      `File is too large to import (${file.identity.byteLength} bytes, limit ${maxBytes}).`
    )
  }
  const bytes = new Uint8Array(file.identity.byteLength)
  let offset = 0
  while (offset < file.identity.byteLength) {
    const length = Math.min(READ_CHUNK_BYTES, file.identity.byteLength - offset)
    const chunk = await invokeNative<NativeFileChunk>('poc_read_external_file_chunk', {
      args: {
        sourceRootPath,
        entryRelativePath: file.relativePath,
        expected: file.identity,
        offset,
        length
      }
    })
    if (chunk.byteLength === 0) {
      break
    }
    bytes.set(base64ToBytes(chunk.contentBase64), offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8').decode(bytes.subarray(0, offset))
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
