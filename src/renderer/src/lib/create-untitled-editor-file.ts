import type { GlobalSettings } from '../../../shared/types'
import {
  createRuntimePath,
  deleteRuntimePath,
  runtimePathExists,
  writeRuntimeFile
} from '../runtime/runtime-file-client'
import { detectLanguage } from './language-detect'
import { joinPath } from './path'
import type { EditorFileOperationProvenance } from './editor-file-operation-owner'

export type UntitledEditorFileInfo = {
  filePath: string
  relativePath: string
  worktreeId: string
  language: string
  isUntitled: true
  deleteUntouchedOnClose?: boolean
  mode: 'edit'
  operationProvenance?: EditorFileOperationProvenance
}

export type CreateUntitledEditorFileOptions = {
  /** Extension including the dot, or '' for an extensionless placeholder. */
  ext: string
  baseName?: string
  /**
   * Written after creation; when set the file is not discarded on an untouched close.
   * Receives the resolved name (`untitled-3.md`), because templates interpolate it.
   */
  initialContent?: (fileName: string) => string
  /** Names the file kind in the name-exhaustion error, e.g. `markdown file`. */
  fileKind?: string
  operationProvenance?: EditorFileOperationProvenance
  expectedSshTargetId?: string
  expectedSshConnectionGeneration?: number
  expectedExecutionHostId?: 'local' | `ssh:${string}`
  assertOperationCurrent?: () => void
}

/**
 * Creates an untitled file on disk and returns the metadata needed by the
 * editor store's `openFile` action.
 *
 * Throws on permission errors or name-collision exhaustion so callers
 * can surface the failure instead of silently dropping it.
 */
export async function createUntitledEditorFile(
  worktreePath: string,
  worktreeId: string,
  connectionId: string | undefined,
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  options: CreateUntitledEditorFileOptions
): Promise<UntitledEditorFileInfo> {
  const baseName = options.baseName ?? 'untitled'
  const ext = options.ext
  const MAX_ATTEMPTS = 100
  const context = {
    settings,
    worktreeId,
    worktreePath,
    connectionId,
    expectedExecutionHostId: options.expectedExecutionHostId,
    expectedSshTargetId: options.expectedSshTargetId,
    expectedSshConnectionGeneration: options.expectedSshConnectionGeneration
  }
  const assertCurrent = (): void => {
    if (options.operationProvenance) {
      requireOperationAssertion(options.assertOperationCurrent)()
    }
  }

  // Why: createFile uses the 'wx' flag, so pathExists is only a hint. Another
  // create can still win the race after our last probe, especially when the
  // user fires the shortcut repeatedly or two split groups create files at
  // nearly the same time. Retrying EEXIST keeps "New Markdown" advancing to
  // the next untitled-N name instead of surfacing a spurious error toast.
  //
  // Why: existence probing must go through the same runtime/SSH-aware file
  // surface as creation; the shell probe only sees the client filesystem.
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const fileName = attempt === 1 ? `${baseName}${ext}` : `${baseName}-${attempt}${ext}`
    const filePath = joinPath(worktreePath, fileName)

    assertCurrent()
    if (await runtimePathExists(context, filePath)) {
      continue
    }

    try {
      assertCurrent()
      await createRuntimePath(context, filePath, 'file')
      if (options.initialContent) {
        try {
          assertCurrent()
          await writeRuntimeFile(context, filePath, options.initialContent(fileName))
        } catch (error) {
          assertCurrent()
          await deleteRuntimePath(context, filePath).catch(() => undefined)
          throw error
        }
      }

      return {
        filePath,
        relativePath: fileName,
        worktreeId,
        language: detectLanguage(fileName),
        isUntitled: true,
        deleteUntouchedOnClose: options.initialContent ? false : undefined,
        operationProvenance: options.operationProvenance,
        mode: 'edit'
      }
    } catch (err) {
      const isEexist =
        err instanceof Error && (err.message.includes('EEXIST') || err.message.includes('exists'))
      if (isEexist && attempt < MAX_ATTEMPTS) {
        continue
      }
      throw err
    }
  }

  throw new Error(
    `Unable to create untitled ${options.fileKind ?? 'file'} after ${MAX_ATTEMPTS} attempts.`
  )
}

export function requireOperationAssertion(assertCurrent: (() => void) | undefined): () => void {
  if (!assertCurrent) {
    throw new Error("Couldn't verify which host owns this file. Reopen the file and try again.")
  }
  return assertCurrent
}
