import {
  getEditorFileReadContext,
  isSameEditorFileOperationIdentity
} from '@/lib/editor/file-operations/editor-file-operation-owner'
import { resolveWorkspaceDirectory } from '@/lib/workspace/paths/workspace-directory'
import { runtimePathsExist } from '@/runtime/files/metadata/runtime-path-existence-batch'
import { readRuntimeFileContent } from '@/runtime/files/reads/runtime-file-read-client'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { AppState } from '@/store/types'
import { relativePathInsideRoot } from '../../../../../../shared/file-access/cross-platform-path'
import { PATH_EXISTENCE_BATCH_MAX } from '../../../../../../shared/file-access/path-existence-batch'
import {
  createImportDefinitionResolver,
  type ImportDefinitionIo
} from '../../../../../../shared/editor-navigation/resolve-import-definition'
import { getEditorModelOwnerKey } from '../../model-lifetime/identity/editor-model-owner'
import { toEditorModelUri } from '../../model-lifetime/identity/editor-model-uri'

export type ImportNavigationSource = {
  file: OpenFile
  worktreePath: string
  /** Identifies the workspace and host, so targets of two hosts never share a preview model. */
  ownerKey: string
  resolve: ReturnType<typeof createImportDefinitionResolver>
  /** False once the source tab closed or moved to another owner; a pending jump must then be dropped. */
  isCurrent: (state: AppState) => boolean
}

function findSourceFile(state: AppState, modelUri: string): OpenFile | undefined {
  return state.openFiles.find(
    (candidate) =>
      candidate.mode === 'edit' &&
      toEditorModelUri(candidate.filePath, getEditorModelOwnerKey(candidate, state)) === modelUri
  )
}

/**
 * The open file a Monaco model belongs to, with a resolver bound to that file's project and host.
 * Built per request: nothing here outlives the ownership it was captured under.
 */
export function findImportNavigationSource(
  state: AppState,
  modelUri: string
): ImportNavigationSource | null {
  const file = findSourceFile(state, modelUri)
  if (!file) {
    return null
  }
  let context: ReturnType<typeof getEditorFileReadContext>
  try {
    // Why the source file's own context: an import target lives on the same host as the file that names it.
    context = getEditorFileReadContext(state, file, null)
  } catch {
    // The file's owner is mid-change; built-in navigation still answers.
    return null
  }
  const worktreePath = resolveWorkspaceDirectory(
    state,
    file.worktreeId,
    context.expectedExecutionHostId
  )
  if (!worktreePath) {
    return null
  }
  const io: ImportDefinitionIo = {
    async pathsExist(paths) {
      const answers: boolean[] = []
      for (let start = 0; start < paths.length; start += PATH_EXISTENCE_BATCH_MAX) {
        const rows = await runtimePathsExist(
          { ...context, worktreePath },
          paths.slice(start, start + PATH_EXISTENCE_BATCH_MAX)
        )
        answers.push(...rows.map((row) => 'exists' in row && row.exists))
      }
      return answers
    },
    async readText(filePath) {
      const relativePath = relativePathInsideRoot(worktreePath, filePath)
      if (relativePath === null) {
        return null
      }
      try {
        const result = await readRuntimeFileContent({
          target: context.target,
          filePath,
          relativePath,
          worktreeId: file.worktreeId,
          connectionId: context.connectionId,
          expectedExternalSshTargetId: context.expectedSshTargetId
        })
        return result.isBinary ? null : result.content
      } catch {
        return null
      }
    }
  }
  return {
    file,
    worktreePath,
    ownerKey: JSON.stringify([
      file.worktreeId,
      file.runtimeEnvironmentId ?? null,
      context.expectedExecutionHostId ?? null,
      worktreePath
    ]),
    resolve: createImportDefinitionResolver({ io, rootPath: worktreePath }),
    isCurrent: (current) =>
      current.openFiles.some((live) => isSameEditorFileOperationIdentity(file, live))
  }
}
