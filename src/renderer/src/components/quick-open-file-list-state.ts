import type { FileExplorerOperationOwner } from '@/components/right-sidebar/file-explorer-types'

export type RuntimeFileListState = {
  files: string[]
  loading: boolean
  loadError: string | null
  recentError?: string | null
  truncated?: boolean
  /** A local index ranked `files` for the query, so callers keep its order. */
  hostRanked?: boolean
  operationOwner?: FileExplorerOperationOwner
}

/** Files settled for one request key; local listings key without the query, so they answer every query. */
export type RuntimeFileListing = {
  requestKey: string
  files: string[]
  truncated: boolean
  recentError?: string | null
}

export const NO_LISTING: RuntimeFileListing = { requestKey: '', files: [], truncated: false }

export function cleanRuntimeFileListError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/^Error invoking remote method '[^']+':\s*Error:\s*/, '')
}
