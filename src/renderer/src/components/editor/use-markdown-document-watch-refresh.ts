import { useEffect } from 'react'
import type { FsChangedPayload } from '../../../../shared/filesystem-entry-types'
import {
  normalizeRuntimePathForComparison,
  relativePathInsideRoot
} from '../../../../shared/cross-platform-path'
import { ORCA_WORKTREE_FILE_CHANGE_EVENT } from '@/hooks/worktree-file-change-event'
import { hasMarkdownExtension } from './markdown-internal-links'
import { MARKDOWN_DOCUMENT_LIST_JOIN_WINDOW_MS } from './markdown-document-list-request'

const DOCUMENT_WATCH_DEBOUNCE_MS = 125

// Why: a remounted pane must not join a scan that predates the latest change its unmounted
// predecessor saw (that pane's pending follow-up died with it).
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

function changesDocumentMembership(payload: FsChangedPayload, rootPath: string): boolean {
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
    return [event.absolutePath, event.oldAbsolutePath].some((path) => {
      if (!path) {
        return false
      }
      const relativePath = relativePathInsideRoot(rootPath, path)
      return (
        relativePath !== null && (event.isDirectory === true || hasMarkdownExtension(relativePath))
      )
    })
  })
}

export function useMarkdownDocumentWatchRefresh({
  enabled,
  worktreePath,
  runtimeEnvironmentId,
  refresh
}: {
  enabled: boolean
  worktreePath: string | null
  runtimeEnvironmentId: string | null | undefined
  refresh: (requireFresh: boolean, freshAfter: number) => Promise<void>
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
      if (eventOwner !== owner || !changesDocumentMembership(payload, worktreePath)) {
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
  }, [enabled, owner, worktreePath, refresh])
}
