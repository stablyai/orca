import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import {
  createRuntimePath,
  deleteRuntimePath,
  writeRuntimeFile
} from '../runtime/runtime-file-mutation-client'
import { runtimePathExists } from '../runtime/runtime-file-metadata-client'
import { detectLanguage } from './language-detect'
import {
  applyMarkdownTemplatePlaceholders,
  getMarkdownTemplateTitleForFileName,
  listMarkdownDocumentTemplates,
  readMarkdownDocumentTemplateContent,
  type MarkdownDocumentTemplate
} from './markdown-document-templates'
import { requestMarkdownTemplateSelection } from './markdown-template-picker-request'
import { basename, joinPath } from './path'
import type { EditorFileOperationProvenance } from './editor-file-operation-owner'
import { getDiskBaselineSignature } from '../../../shared/disk-baseline-signature'

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
  /** Recovered text goes into a new `<name> (recovered)<ext>` file, never the original path. */
  recoveredDocument?: { originalPath: string; content: string }
  /** A plugin's new-file type: `untitled<extension>` seeded with its template text, unchanged. */
  newFile?: { extension: string; content: string }
  now?: Date
  operationProvenance?: EditorFileOperationProvenance
  expectedSshTargetId?: string
  expectedSshConnectionGeneration?: number
  expectedExecutionHostId?: 'local' | `ssh:${string}`
  assertOperationCurrent?: () => void
}

/** Create a file and return openFile metadata; throw permission/collision exhaustion errors so callers cannot silently drop failures. */
export async function createUntitledMarkdownFile(
  worktreePath: string,
  worktreeId: string,
  connectionId: string | undefined,
  target: RuntimeClientTarget,
  options: CreateUntitledMarkdownOptions = {}
): Promise<UntitledMarkdownFileInfo> {
  const recovered = options.recoveredDocument
  const newFile = options.newFile
  const fileNameFor = recovered
    ? recoveredFileName(recovered.originalPath)
    : untitledFileNameWith(newFile?.extension ?? '.md')
  const MAX_ATTEMPTS = 100
  const context = {
    target,
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

  // Existence is only a hint: createFile uses wx, so retry EEXIST races with the next name. Probe via the same runtime/SSH-aware files API, never the local shell.
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const fileName = fileNameFor(attempt)
    const filePath = joinPath(worktreePath, fileName)

    assertCurrent()
    if (await runtimePathExists(context, filePath)) {
      continue
    }

    try {
      assertCurrent()
      await createRuntimePath(context, filePath, 'file')
      const content =
        recovered?.content ??
        (newFile ? newFile.content || null : null) ??
        (templateContent === null
          ? null
          : applyMarkdownTemplatePlaceholders(templateContent, {
              title: getMarkdownTemplateTitleForFileName(fileName),
              filename: fileName,
              now: options.now
            }))
      if (content !== null) {
        let written: Awaited<ReturnType<typeof writeRuntimeFile>>
        try {
          assertCurrent()
          // Why guarded: only the empty file this create made may be filled, never another writer's.
          written = await writeRuntimeFile(context, filePath, content, undefined, {
            expectedSignature: getDiskBaselineSignature('')
          })
        } catch (error) {
          assertCurrent()
          // Why: recovered text must never cost a file that replaced ours; a template leftover may go.
          if (!recovered) {
            await deleteRuntimePath(context, filePath).catch(() => undefined)
          }
          throw error
        }
        if (!written.ok) {
          continue
        }
      }

      return {
        filePath,
        relativePath: fileName,
        worktreeId,
        language: detectLanguage(fileName),
        isUntitled: true,
        deleteUntouchedOnClose:
          recovered || templateContent !== null || newFile?.content ? false : undefined,
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
  connectionId: string | undefined,
  target: RuntimeClientTarget,
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
    target,
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

  return createUntitledMarkdownFile(worktreePath, worktreeId, connectionId, target, {
    template: selection.type === 'template' ? selection.template : undefined,
    operationProvenance,
    expectedSshTargetId,
    expectedSshConnectionGeneration,
    expectedExecutionHostId,
    assertOperationCurrent
  })
}

function untitledFileNameWith(extension: string): (attempt: number) => string {
  return (attempt) => (attempt === 1 ? `untitled${extension}` : `untitled-${attempt}${extension}`)
}

function recoveredFileName(originalPath: string): (attempt: number) => string {
  const name = basename(originalPath)
  const dot = name.lastIndexOf('.')
  const stem = (dot > 0 ? name.slice(0, dot) : name) || 'untitled'
  const ext = dot > 0 ? name.slice(dot) : ''
  return (attempt) => `${stem} (recovered${attempt === 1 ? '' : ` ${attempt}`})${ext}`
}

function requireOperationAssertion(assertCurrent: (() => void) | undefined): () => void {
  if (!assertCurrent) {
    throw new Error("Couldn't verify which host owns this file. Reopen the file and try again.")
  }
  return assertCurrent
}
