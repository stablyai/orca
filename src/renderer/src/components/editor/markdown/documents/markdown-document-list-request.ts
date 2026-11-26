import type { MarkdownDocument } from '../../../../../../shared/file-listing/file-document'
import { listRuntimeMarkdownDocuments } from '@/runtime/files/metadata/runtime-file-metadata-client'
import type { RuntimeFileOperationArgs } from '@/runtime/files/runtime-file-client-types'

type MarkdownDocumentListLoader = (
  context: RuntimeFileOperationArgs,
  rootPath: string
) => Promise<MarkdownDocument[]>

type MarkdownDocumentListRequestOptions = {
  requireFresh?: boolean
  freshAfter?: number
}

type InFlightMarkdownDocumentList = {
  request: Promise<MarkdownDocument[]>
  startedAt: number
}

export const MARKDOWN_DOCUMENT_LIST_JOIN_WINDOW_MS = 30_000
const inFlightMarkdownDocumentLists = new Map<string, InFlightMarkdownDocumentList>()
// Share one exact-membership index per listing array so split panes joining a listing do not duplicate it.
const relativePathsByDocuments = new WeakMap<readonly MarkdownDocument[], ReadonlySet<string>>()

export function getMarkdownDocumentRelativePaths(
  documents: readonly MarkdownDocument[]
): ReadonlySet<string> {
  let relativePaths = relativePathsByDocuments.get(documents)
  if (!relativePaths) {
    const next = new Set<string>()
    for (const document of documents) {
      next.add(document.relativePath)
    }
    relativePathsByDocuments.set(documents, next)
    relativePaths = next
  }
  return relativePaths
}

export function getMarkdownDocumentListRequestKey(
  context: RuntimeFileOperationArgs,
  rootPath: string
): string {
  return JSON.stringify([
    context.target.kind === 'environment' ? context.target.environmentId : '',
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
  // Sweep abandoned routes so hung scans cannot retain their captured contexts for the renderer’s lifetime.
  for (const [staleKey, entry] of inFlightMarkdownDocumentLists) {
    if (now - entry.startedAt >= MARKDOWN_DOCUMENT_LIST_JOIN_WINDOW_MS) {
      inFlightMarkdownDocumentLists.delete(staleKey)
    }
  }

  const key = getMarkdownDocumentListRequestKey(context, rootPath)
  const existing = inFlightMarkdownDocumentLists.get(key)
  if (
    existing &&
    !options.requireFresh &&
    (options.freshAfter === undefined || existing.startedAt > options.freshAfter)
  ) {
    return existing.request
  }

  // Share simultaneous pane scans; mutation refreshes bypass stale snapshots.
  const request = load(context, rootPath).finally(() => {
    if (inFlightMarkdownDocumentLists.get(key)?.request === request) {
      inFlightMarkdownDocumentLists.delete(key)
    }
  })
  // Bound joins because local/UNC calls can hang indefinitely and must not block later retries.
  inFlightMarkdownDocumentLists.set(key, { request, startedAt: now })
  return request
}
