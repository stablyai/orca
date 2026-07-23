import type { GlobalSettings } from '../../../shared/types'
import {
  createRuntimePath,
  deleteRuntimePath,
  runtimePathExists,
  writeRuntimeFile
} from '../runtime/runtime-file-client'
import { detectLanguage } from './language-detect'
import {
  applyMarkdownTemplatePlaceholders,
  getMarkdownTemplateTitleForFileName,
  listMarkdownDocumentTemplates,
  readMarkdownDocumentTemplateContent,
  type MarkdownDocumentTemplate
} from './markdown-document-templates'
import { requestMarkdownTemplateSelection } from './markdown-template-picker-request'
import { joinPath } from './path'
import type { EditorFileOperationProvenance } from './editor-file-operation-owner'

export type UntitledMarkdownFileInfo = {
  filePath: string
  relativePath: string
  worktreeId: string
  language: string
  isUntitled: true
  deleteUntouchedOnClose?: boolean
  mode: 'edit'
  operationProvenance?: EditorFileOperationProvenance
}

type CreateUntitledMarkdownOptions = {
  template?: MarkdownDocumentTemplate
  now?: Date
  operationProvenance?: EditorFileOperationProvenance
  expectedSshTargetId?: string
  expectedSshConnectionGeneration?: number
  expectedExecutionHostId?: 'local' | `ssh:${string}`
  assertOperationCurrent?: () => void
}

/**
 * Creates an untitled markdown file on disk and returns the metadata
 * needed by the editor store's `openFile` action.
 *
 * Throws on permission errors or name-collision exhaustion so callers
 * can surface the failure instead of silently dropping it.
 */
export async function createUntitledMarkdownFile(
  worktreePath: string,
  worktreeId: string,
  connectionId?: string,
  settings?: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null,
  options: CreateUntitledMarkdownOptions = {}
): Promise<UntitledMarkdownFileInfo> {
  const baseName = 'untitled'
  const ext = '.md'
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
  const templateContent = options.template
    ? await readMarkdownDocumentTemplateContent(context, options.template)
    : null

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
      if (templateContent !== null) {
        try {
          assertCurrent()
          await writeRuntimeFile(
            context,
            filePath,
            applyMarkdownTemplatePlaceholders(templateContent, {
              title: getMarkdownTemplateTitleForFileName(fileName),
              filename: fileName,
              now: options.now
            })
          )
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
        deleteUntouchedOnClose: templateContent === null ? undefined : false,
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

  throw new Error(`Unable to create untitled markdown file after ${MAX_ATTEMPTS} attempts.`)
}

export async function createUntitledMarkdownFileWithTemplateSelection(
  worktreePath: string,
  worktreeId: string,
  connectionId?: string,
  settings?: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null,
  operationProvenance?: EditorFileOperationProvenance,
  expectedSshConnectionGeneration?: number,
  expectedSshTargetId?: string,
  expectedExecutionHostId?: 'local' | `ssh:${string}`,
  assertOperationCurrent?: () => void
): Promise<UntitledMarkdownFileInfo | null> {
  if (operationProvenance) {
    requireOperationAssertion(assertOperationCurrent)()
  }
  const context = {
    settings,
    worktreeId,
    worktreePath,
    connectionId,
    expectedExecutionHostId,
    expectedSshTargetId,
    expectedSshConnectionGeneration
  }
  const templates = await listMarkdownDocumentTemplates(context, worktreePath)
  const selection = await requestMarkdownTemplateSelection(templates)

  if (selection.type === 'cancel') {
    return null
  }

  return createUntitledMarkdownFile(worktreePath, worktreeId, connectionId, settings, {
    template: selection.type === 'template' ? selection.template : undefined,
    operationProvenance,
    expectedSshTargetId,
    expectedSshConnectionGeneration,
    expectedExecutionHostId,
    assertOperationCurrent
  })
}

function requireOperationAssertion(assertCurrent: (() => void) | undefined): () => void {
  if (!assertCurrent) {
    throw new Error("Couldn't verify which host owns this file. Reopen the file and try again.")
  }
  return assertCurrent
}
