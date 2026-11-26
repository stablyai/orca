import { useEffect } from 'react'
import type { FsChangedPayload } from '../../../../../../shared/file-watch/filesystem-change-event'
import {
  normalizeRuntimePathForComparison,
  relativePathInsideRoot
} from '../../../../../../shared/file-access/cross-platform-path'
import { ORCA_WORKTREE_FILE_CHANGE_EVENT } from '@/runtime/files/watching/worktree-file-change-event'
import { hasMarkdownExtension } from '../link-routing/markdown-internal-links'
import { MARKDOWN_DOCUMENT_LIST_JOIN_WINDOW_MS } from './markdown-document-list-request'

const DOCUMENT_WATCH_DEBOUNCE_MS = 125
const isNeverListed = (): boolean => false

// Remounted panes must bypass scans older than the latest observed change because unmount cancels their predecessor’s follow-up.
const latestMembershipChangeAt = new Map<string, number>()
const membershipChangeKey = (owner: string | null, rootPath: string): string =>
  `${owner ?? ''}::${normalizeRuntimePathForComparison(rootPath)}`

export function getLatestMarkdownMembershipChangeAt(
  runtimeEnvironmentId: string | null | undefined,
  rootPath: string
): number | undefined {
  return latestMembershipChangeAt.get(
    membershipChangeKey(runtimeEnvironmentId?.trim() || null, rootPath)
  )
}

function documentPathInsideRoot(
  rootPath: string,
  path: string | undefined,
  isDirectory: boolean | undefined
): string | null {
  const relativePath = path ? relativePathInsideRoot(rootPath, path) : null
  return relativePath !== null && (isDirectory === true || hasMarkdownExtension(relativePath))
    ? relativePath
    : null
}

function changesDocumentMembership(
  payload: FsChangedPayload,
  rootPath: string,
  isListed: (relativePath: string) => boolean
): boolean {
  if (
    normalizeRuntimePathForComparison(payload.worktreePath) !==
    normalizeRuntimePathForComparison(rootPath)
  ) {
    return false
  }

  return payload.events.some((event) => {
    if (event.kind === 'overflow') {
      return true
    }
    if (event.kind === 'update') {
      return false
    }
    if (documentPathInsideRoot(rootPath, event.oldAbsolutePath, event.isDirectory) !== null) {
      return true
    }
    const relativePath = documentPathInsideRoot(rootPath, event.absolutePath, event.isDirectory)
    if (relativePath === null) {
      return false
    }
    // An atomic save lands as a create or rename onto a document the list already holds.
    return event.kind === 'delete' || event.isDirectory === true || !isListed(relativePath)
  })
}

export function useMarkdownDocumentWatchRefresh({
  enabled,
  worktreePath,
  runtimeEnvironmentId,
  refresh,
  isListed
}: {
  enabled: boolean
  worktreePath: string | null
  runtimeEnvironmentId: string | null | undefined
  refresh: (requireFresh: boolean, freshAfter: number) => Promise<void>
  /** Whether the settled list holds this root-relative path; false while a listing is in flight. */
  isListed: (relativePath: string) => boolean
}): void {
  const owner = runtimeEnvironmentId?.trim() || null

  useEffect(() => {
    if (!enabled || !worktreePath) {
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    let latestChangeAt = 0
    let scanSeq = 0
    let activeScan: number | null = null
    let scanWatchdog: ReturnType<typeof setTimeout> | undefined
    let watchdogScale = 1
    let changedDuringScan = false
    let disposed = false
    const endScan = (scan: number): void => {
      if (activeScan !== scan) {
        return
      }
      activeScan = null
      clearTimeout(scanWatchdog)
      // Why: one scan at a time — overlapping scans supersede each other and publish nothing.
      if (changedDuringScan && !disposed) {
        scheduleScan()
      }
    }
    const scheduleScan = (): void => {
      // Why: never push an armed scan back; watch batches arrive faster than the debounce under sustained writes.
      if (timer !== undefined) {
        return
      }
      timer = setTimeout(() => {
        timer = undefined
        const scan = ++scanSeq
        activeScan = scan
        changedDuringScan = false
        // Why: listings have no timeout; a doubling watchdog frees a hung scan yet lets a slow one publish.
        scanWatchdog = setTimeout(() => {
          watchdogScale = Math.min(watchdogScale * 2, 8)
          endScan(scan)
        }, MARKDOWN_DOCUMENT_LIST_JOIN_WINDOW_MS * watchdogScale)
        // Each pane can join a scan begun after the latest change, while bypassing an older snapshot.
        void refresh(false, latestChangeAt).finally(() => {
          if (activeScan === scan) {
            watchdogScale = 1
          }
          endScan(scan)
        })
      }, DOCUMENT_WATCH_DEBOUNCE_MS)
    }
    const handleChange = (event: WindowEventMap[typeof ORCA_WORKTREE_FILE_CHANGE_EVENT]): void => {
      const { payload, runtimeEnvironmentId: eventOwner } = event.detail
      // Why: once a scan is armed or running, a recreate after a delete must still advance freshAfter.
      const listed = timer === undefined && activeScan === null ? isListed : isNeverListed
      if (eventOwner !== owner || !changesDocumentMembership(payload, worktreePath, listed)) {
        return
      }
      latestChangeAt = performance.now()
      latestMembershipChangeAt.set(membershipChangeKey(owner, worktreePath), latestChangeAt)
      if (activeScan !== null) {
        changedDuringScan = true
        return
      }
      scheduleScan()
    }
    window.addEventListener(ORCA_WORKTREE_FILE_CHANGE_EVENT, handleChange)
    return () => {
      disposed = true
      clearTimeout(timer)
      clearTimeout(scanWatchdog)
      window.removeEventListener(ORCA_WORKTREE_FILE_CHANGE_EVENT, handleChange)
    }
  }, [enabled, owner, worktreePath, refresh, isListed])
}
