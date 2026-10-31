import type { ImportSkipReason } from '../../../shared/filesystem-import-result-types'

export type ComposerDropItemResult =
  | {
      status: 'imported'
      destPath: string
      kind: 'file' | 'directory'
    }
  | {
      status: 'skipped'
      reason: ImportSkipReason
    }
  | {
      status: 'failed'
      reason?: string
    }

export type ComposerDropFailure = Exclude<ComposerDropItemResult, { status: 'imported' }>

export type ComposerDropResult = {
  filePaths: string[]
  folderPaths: string[]
  failureCount: number
  commonFailure?: ComposerDropFailure
}

function sameFailure(left: ComposerDropFailure, right: ComposerDropFailure): boolean {
  return left.status === right.status && left.reason === right.reason
}

export function collectComposerDropResult(
  results: readonly ComposerDropItemResult[]
): ComposerDropResult {
  const filePaths: string[] = []
  const folderPaths: string[] = []
  const failures: ComposerDropFailure[] = []

  for (const result of results) {
    if (result.status !== 'imported') {
      failures.push(result)
    } else if (result.kind === 'directory') {
      folderPaths.push(result.destPath)
    } else {
      filePaths.push(result.destPath)
    }
  }

  const firstFailure = failures[0]
  return {
    filePaths,
    folderPaths,
    failureCount: failures.length,
    commonFailure:
      firstFailure && failures.every((failure) => sameFailure(firstFailure, failure))
        ? firstFailure
        : undefined
  }
}
