import type { GitBranchChangeStatus } from './git-status-types'
import type { LargeDiffRenderLimit } from './large-diff-render-limit'

// ─── Git Status ─────────────────────────────────────────────
// Re-exported from git-status-types.ts so mobile shares the wire contract without this desktop aggregate.

export type GitBranchChangeEntry = {
  path: string
  status: GitBranchChangeStatus
  oldPath?: string
  added?: number
  removed?: number
}

export type GitBranchCompareSummary = {
  baseRef: string
  baseOid: string | null
  compareRef: string
  headOid: string | null
  mergeBase: string | null
  changedFiles: number
  commitsAhead?: number
  commitsBehind?: number
  status: 'ready' | 'invalid-base' | 'unborn-head' | 'no-merge-base' | 'loading' | 'error'
  errorMessage?: string
}

export type GitBranchCompareResult = {
  summary: GitBranchCompareSummary
  entries: GitBranchChangeEntry[]
}

export type GitCommitCompareSummary = {
  commitOid: string
  parentOid: string | null
  compareRef: string
  baseRef: string
  changedFiles: number
  status: 'ready' | 'invalid-commit' | 'error'
  errorMessage?: string
}

export type GitCommitCompareResult = {
  summary: GitCommitCompareSummary
  entries: GitBranchChangeEntry[]
}

export type GitDiffTextResult = {
  kind: 'text'
  originalContent: string
  modifiedContent: string
  originalIsBinary: false
  modifiedIsBinary: false
  largeDiffRenderLimit?: LargeDiffRenderLimit
}

export type GitDiffBinaryResult = {
  kind: 'binary'
  originalContent: string
  modifiedContent: string
  /** Legacy flag used by the renderer for any binary format it can preview, including PDFs. */
  isImage?: boolean
  /** MIME type for binary preview rendering, e.g. "image/png" or "application/pdf" */
  mimeType?: string
  /** True only for a proven deletion — distinct from an empty modified side caused by a read failure or size cap. */
  modifiedDeleted?: boolean
} & (
  | { originalIsBinary: true; modifiedIsBinary: boolean }
  | { originalIsBinary: boolean; modifiedIsBinary: true }
)

export type GitDiffResult = GitDiffTextResult | GitDiffBinaryResult
