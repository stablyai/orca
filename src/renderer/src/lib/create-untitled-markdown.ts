import type { GlobalSettings } from '../../../shared/types'
import {
  createUntitledEditorFile,
  requireOperationAssertion,
  type UntitledEditorFileInfo
} from './create-untitled-editor-file'
import {
  applyMarkdownTemplatePlaceholders,
  getMarkdownTemplateTitleForFileName,
  listMarkdownDocumentTemplates,
  readMarkdownDocumentTemplateContent,
  type MarkdownDocumentTemplate
} from './markdown-document-templates'
import { requestMarkdownTemplateSelection } from './markdown-template-picker-request'
import type { EditorFileOperationProvenance } from './editor-file-operation-owner'

export type UntitledMarkdownFileInfo = UntitledEditorFileInfo

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
  // Why: must mirror the context the core builds, or the template read and the
  // file write would route to different hosts.
  const context = {
    settings,
    worktreeId,
    worktreePath,
    connectionId,
    expectedExecutionHostId: options.expectedExecutionHostId,
    expectedSshTargetId: options.expectedSshTargetId,
    expectedSshConnectionGeneration: options.expectedSshConnectionGeneration
  }
  const templateContent = options.template
    ? await readMarkdownDocumentTemplateContent(context, options.template)
    : null

  return createUntitledEditorFile(worktreePath, worktreeId, connectionId, settings, {
    ext: '.md',
    exhaustionErrorLabel: 'markdown file',
    // Why: placeholders interpolate the resolved name, which the collision loop
    // may bump to untitled-3.md, so the content cannot be built up front.
    initialContent:
      templateContent === null
        ? undefined
        : (fileName) =>
            applyMarkdownTemplatePlaceholders(templateContent, {
              title: getMarkdownTemplateTitleForFileName(fileName),
              filename: fileName,
              now: options.now
            }),
    operationProvenance: options.operationProvenance,
    expectedSshTargetId: options.expectedSshTargetId,
    expectedSshConnectionGeneration: options.expectedSshConnectionGeneration,
    expectedExecutionHostId: options.expectedExecutionHostId,
    assertOperationCurrent: options.assertOperationCurrent
  })
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
