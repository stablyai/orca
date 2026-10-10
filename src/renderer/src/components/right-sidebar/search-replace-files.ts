import {
  getOpenFilesForExternalFileChange,
  notifyEditorExternalFileChange,
  requestEditorSaveQuiesce,
  type EditorPathMutationTarget
} from '@/components/editor/editor-autosave'
import { readRuntimeFileContent, writeRuntimeFile } from '@/runtime/runtime-file-client'
import { useAppStore } from '@/store'
import type { SearchFileResult } from '../../../../shared/code-search-types'
import type { FileExplorerOperationGuard } from './file-explorer-operation-owner'
import {
  replaceInText,
  type CompiledSearchReplace,
  type SearchReplaceTarget
} from './search-replace-text'

export type SearchReplaceFileOutcome =
  | { kind: 'replaced'; count: number }
  | { kind: 'stale' }
  | { kind: 'dirty' }
  | { kind: 'notUtf8' }
  | { kind: 'failed'; message: string }

export type SearchReplaceFileJob = {
  fileResult: SearchFileResult
  /** Defaults to every match the search listed for the file. */
  targets?: readonly SearchReplaceTarget[]
}

export type SearchReplaceContext = {
  worktreeId: string
  worktreePath: string
  runtimeEnvironmentId: string | null
  guard: FileExplorerOperationGuard
  compiled: CompiledSearchReplace
}

const REPLACE_FILE_CONCURRENCY = 4

async function replaceInSearchFile(
  context: SearchReplaceContext,
  job: SearchReplaceFileJob
): Promise<SearchReplaceFileOutcome> {
  const { fileResult } = job
  const mutationTarget: EditorPathMutationTarget = {
    worktreeId: context.worktreeId,
    worktreePath: context.worktreePath,
    relativePath: fileResult.relativePath,
    runtimeEnvironmentId: context.runtimeEnvironmentId
  }
  // Why: writing under an unsaved tab would strand its draft against newer disk content.
  const openTabs = getOpenFilesForExternalFileChange(
    useAppStore.getState().openFiles,
    mutationTarget
  )
  if (openTabs.some((file) => file.isDirty)) {
    return { kind: 'dirty' }
  }
  try {
    await requestEditorSaveQuiesce(mutationTarget)
    const readRoute = context.guard.assertCurrent()
    const file = await readRuntimeFileContent({
      settings: readRoute.settings,
      filePath: fileResult.filePath,
      relativePath: fileResult.relativePath,
      worktreeId: context.worktreeId,
      connectionId: readRoute.connectionId
    })
    if (file.isBinary) {
      return { kind: 'stale' }
    }
    // Why: reads decode as UTF-8, so writing back a lossy decode would corrupt other encodings.
    if (file.content.includes('\uFFFD')) {
      return { kind: 'notUtf8' }
    }
    const next = replaceInText(file.content, context.compiled, job.targets ?? fileResult.matches)
    if (next.count === 0) {
      return { kind: 'stale' }
    }
    const writeRoute = context.guard.assertCurrent()
    await writeRuntimeFile(
      { ...writeRoute, worktreeId: context.worktreeId, worktreePath: context.worktreePath },
      fileResult.filePath,
      next.content
    )
    notifyEditorExternalFileChange(mutationTarget)
    return { kind: 'replaced', count: next.count }
  } catch (error) {
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}

export type SearchReplaceSummary = {
  replacedCount: number
  replacedFiles: number
  dirtyFiles: string[]
  staleFiles: string[]
  notUtf8Files: string[]
  failures: { relativePath: string; message: string }[]
}

export async function replaceInSearchFiles(
  context: SearchReplaceContext,
  jobs: readonly SearchReplaceFileJob[]
): Promise<SearchReplaceSummary> {
  const summary: SearchReplaceSummary = {
    replacedCount: 0,
    replacedFiles: 0,
    dirtyFiles: [],
    staleFiles: [],
    notUtf8Files: [],
    failures: []
  }
  let nextJob = 0
  const worker = async (): Promise<void> => {
    while (nextJob < jobs.length) {
      const job = jobs[nextJob++]
      const outcome = await replaceInSearchFile(context, job)
      if (outcome.kind === 'replaced') {
        summary.replacedCount += outcome.count
        summary.replacedFiles += 1
      } else if (outcome.kind === 'dirty') {
        summary.dirtyFiles.push(job.fileResult.relativePath)
      } else if (outcome.kind === 'stale') {
        summary.staleFiles.push(job.fileResult.relativePath)
      } else if (outcome.kind === 'notUtf8') {
        summary.notUtf8Files.push(job.fileResult.relativePath)
      } else if (outcome.kind === 'failed') {
        summary.failures.push({
          relativePath: job.fileResult.relativePath,
          message: outcome.message
        })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(REPLACE_FILE_CONCURRENCY, jobs.length) }, worker))
  return summary
}
