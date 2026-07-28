import type { MarkdownDocument } from '../../../../shared/types'
import {
  listRuntimeMarkdownDocuments,
  type RuntimeFileOperationArgs
} from '@/runtime/runtime-file-client'
import { MarkdownDocumentListingCapacityError } from '../../../../shared/markdown-document-listing-limits'

type MarkdownDocumentListLoader = (
  context: RuntimeFileOperationArgs,
  rootPath: string
) => Promise<MarkdownDocument[]>

type MarkdownDocumentListRequestOptions = {
  requireFresh?: boolean
}

type InFlightMarkdownDocumentList = {
  request: Promise<MarkdownDocument[]>
  startedAt: number
}

const MARKDOWN_DOCUMENT_LIST_JOIN_WINDOW_MS = 30_000
export const MARKDOWN_DOCUMENT_LIST_MAX_IN_FLIGHT = 16
const inFlightMarkdownDocumentLists = new Map<string, InFlightMarkdownDocumentList>()
let activeMarkdownDocumentListLoads = 0

export function getMarkdownDocumentListRequestKey(
  context: RuntimeFileOperationArgs,
  rootPath: string
): string {
  return JSON.stringify([
    context.settings?.activeRuntimeEnvironmentId?.trim() ?? '',
    context.connectionId ?? '',
    context.worktreeId ?? '',
    context.worktreePath ?? '',
    rootPath
  ])
}

export function requestSharedMarkdownDocumentList(
  context: RuntimeFileOperationArgs,
  rootPath: string,
  options: MarkdownDocumentListRequestOptions = {},
  load: MarkdownDocumentListLoader = listRuntimeMarkdownDocuments
): Promise<MarkdownDocument[]> {
  const now = performance.now()
  // Why: a never-settling scan for a route that is never requested again would
  // otherwise pin its map entry (and captured context) for the renderer's life.
  for (const [staleKey, entry] of inFlightMarkdownDocumentLists) {
    if (now - entry.startedAt >= MARKDOWN_DOCUMENT_LIST_JOIN_WINDOW_MS) {
      inFlightMarkdownDocumentLists.delete(staleKey)
    }
  }

  const key = getMarkdownDocumentListRequestKey(context, rootPath)
  const existing = inFlightMarkdownDocumentLists.get(key)
  if (existing && !options.requireFresh) {
    return existing.request
  }
  if (activeMarkdownDocumentListLoads >= MARKDOWN_DOCUMENT_LIST_MAX_IN_FLIGHT) {
    return Promise.reject(new MarkdownDocumentListingCapacityError())
  }

  // Why: split Markdown panes mount together and otherwise launch identical
  // whole-worktree local/SSH scans; mutation refreshes bypass older snapshots.
  activeMarkdownDocumentListLoads += 1
  let loaded: Promise<MarkdownDocument[]>
  try {
    loaded = load(context, rootPath)
  } catch (error) {
    activeMarkdownDocumentListLoads -= 1
    return Promise.reject(error)
  }
  const request = loaded.finally(() => {
    activeMarkdownDocumentListLoads -= 1
    if (inFlightMarkdownDocumentLists.get(key)?.request === request) {
      inFlightMarkdownDocumentLists.delete(key)
    }
  })
  // Why: local and UNC filesystem calls have no timeout, so an abandoned scan
  // must not suppress every ordinary retry for the renderer's lifetime.
  inFlightMarkdownDocumentLists.set(key, { request, startedAt: now })
  return request
}
