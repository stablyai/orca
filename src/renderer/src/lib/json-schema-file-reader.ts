import { URI } from 'monaco-editor/esm/vs/base/common/uri.js'
import { useAppStore } from '@/store'
import { toEditorModelUri } from '@/components/editor/editor-model-uri'
import { getEditorModelOwnerKey } from '@/components/editor/editor-model-owner'
import { getEditorFileOperationContext } from './editor-file-operation-owner'
import { readRuntimeFilePreview } from '@/runtime/runtime-file-read-client'
import {
  isWindowsAbsolutePathLike,
  normalizeRuntimePathSeparators,
  relativePathInsideRoot
} from '../../../shared/cross-platform-path'

export async function readJsonSchemaFile(uri: string): Promise<string> {
  const requested = URI.parse(uri)
  if (requested.scheme !== 'file' && requested.scheme !== 'vscode-remote') {
    throw new Error('Unsupported JSON schema URI')
  }
  const state = useAppStore.getState()
  if (
    requested.scheme === 'file' &&
    state.openFiles.some((file) => {
      const owner = getEditorModelOwnerKey(file, state)
      const root = file.filePath.slice(0, file.filePath.length - file.relativePath.length - 1)
      return owner && relativePathInsideRoot(root, requested.fsPath) !== null
    })
  ) {
    // An absolute file: reference drops the remote authority. Require a relative reference rather than borrow a local host.
    throw new Error('Use a relative workspace schema reference for remote files')
  }
  for (const file of state.openFiles) {
    const model = URI.parse(toEditorModelUri(file.filePath, getEditorModelOwnerKey(file, state)))
    if (model.scheme !== requested.scheme || model.authority !== requested.authority) {
      continue
    }
    const root = file.filePath.slice(0, file.filePath.length - file.relativePath.length - 1)
    const filePath =
      requested.scheme === 'file'
        ? requested.fsPath
        : !isWindowsAbsolutePathLike(root)
          ? requested.path
          : requested.authority.endsWith('-unc')
            ? `/${requested.path}`
            : normalizeRuntimePathSeparators(requested.path.replace(/^\/(?=[a-z]:[\\/]|\\\\)/i, ''))
    if (!root || relativePathInsideRoot(root, filePath) === null) {
      continue
    }
    const context = getEditorFileOperationContext(state, file, root)
    const result = await readRuntimeFilePreview(context, filePath)
    if (result.isBinary) {
      throw new Error('JSON schema is not a text file')
    }
    return result.content
  }
  throw new Error('JSON schema is outside the owning open workspace')
}
