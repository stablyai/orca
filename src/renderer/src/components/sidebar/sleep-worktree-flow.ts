import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { clearWorktreeSleepIntent, markWorktreeSleepIntent } from '@/lib/worktree-sleep-intent'
import { VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT } from '@/hooks/useVirtualizedScrollAnchor'
import { translate } from '@/i18n/i18n'

/**
 * Shared "sleep worktree" flow (close all panels to free memory / CPU)
 * used by WorktreeContextMenu and MemoryStatusSegment's per-row hover action.
 *
 * Why this is a module helper rather than inlined at each call site: the guard
 * that clears `activeWorktreeId` before tearing down terminals isn't optional
 * polish — shutting down the active worktree while its TerminalPane is still
 * visible causes a visible "reboot" flicker and can crash the pane (PTY exit
 * callbacks race against the live xterm instance). See the original comment
 * in WorktreeContextMenu's handleCloseTerminals for the full reasoning.
 * Centralizing the sequence here keeps that safety invariant in one place so
 * a new caller can't accidentally skip it.
 */
export async function runSleepWorktree(worktreeId: string): Promise<void> {
  await runSleepWorktrees([worktreeId])
}

function getSidebarWorktreeOptions(worktreeId: string): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-worktree-id]')).filter(
    (element) => element.dataset.worktreeId === worktreeId
  )
}

function isPinnedSidebarWorktreeOption(element: HTMLElement): boolean {
  // Why: duplicated pinned rows share a worktree id; the row-key prefix is the
  // stable row-scoped signal that distinguishes the pinned copy from natural rows.
  return element.dataset.worktreeRowKey?.startsWith('pinned:') === true
}

function findPrimarySidebarWorktreeOption(worktreeId: string): HTMLElement | null {
  const options = getSidebarWorktreeOptions(worktreeId)
  return (
    options.find((element) =>
      element.querySelector<HTMLElement>('[data-worktree-card-active="primary"]')
    ) ??
    options.find((element) => !isPinnedSidebarWorktreeOption(element)) ??
    options[0] ??
    null
  )
}

function findSidebarWorktreeRow(worktreeId: string, rowKey?: string): HTMLElement | null {
  const options = getSidebarWorktreeOptions(worktreeId)
  const option = rowKey
    ? (options.find((element) => element.dataset.worktreeRowKey === rowKey) ?? null)
    : (findPrimarySidebarWorktreeOption(worktreeId) ?? null)
  return option?.closest<HTMLElement>('[data-worktree-virtual-row]') ?? null
}

function preserveSidebarWorktreePosition(worktreeId: string): () => void {
  if (typeof document === 'undefined') {
    return () => {}
  }
  const getScroller = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('[data-worktree-sidebar]')
  const scroller = getScroller()
  const activeOption = findPrimarySidebarWorktreeOption(worktreeId)
  const activeRowKey = activeOption?.dataset.worktreeRowKey
  const row = activeOption?.closest<HTMLElement>('[data-worktree-virtual-row]') ?? null
  if (!scroller || !row) {
    return () => {}
  }
  scroller.dispatchEvent(new Event(VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT))
  const previousScrollTop = scroller.scrollTop
  const previousScrollHeight = scroller.scrollHeight
  const previousTop = row.getBoundingClientRect().top

  return () => {
    let attempts = 0
    const restore = (): void => {
      const currentScroller = getScroller()
      if (!currentScroller) {
        attempts += 1
        if (attempts < 12) {
          window.requestAnimationFrame(restore)
        }
        return
      }
      const nextRow = findSidebarWorktreeRow(worktreeId, activeRowKey)
      if (!nextRow) {
        // Why: a remount can first render the wrong virtual window. Put the
        // scroller near the same content after height changes so the row
        // mounts, then retry and correct by actual DOM position.
        currentScroller.scrollTop = Math.max(
          0,
          previousScrollTop + currentScroller.scrollHeight - previousScrollHeight
        )
      } else {
        const delta = nextRow.getBoundingClientRect().top - previousTop
        if (Math.abs(delta) > 1) {
          currentScroller.scrollTop += delta
        }
      }
      attempts += 1
      if (attempts < 12) {
        window.requestAnimationFrame(restore)
      }
    }
    window.requestAnimationFrame(restore)
  }
}

function describeSleepFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  if (detail.includes('legacy')) {
    return translate(
      'auto.components.sidebar.sleep.worktree.flow.legacy.unverified',
      'The older host runtime could not confirm terminal shutdown. The workspace was kept open; update the host and try again.'
    )
  }
  if (
    detail.includes('terminal_') ||
    detail.includes('runtime') ||
    detail.includes('connection') ||
    detail.includes('Daemon')
  ) {
    return translate(
      'auto.components.sidebar.sleep.worktree.flow.host.unverified',
      'The host could not confirm terminal shutdown. The workspace was kept open; check the connection and try again.'
    )
  }
  return translate(
    'auto.components.sidebar.sleep.worktree.flow.retry',
    'The workspace was kept open. Try again; if the problem continues, check the host connection.'
  )
}

export async function runSleepWorktrees(worktreeIds: readonly string[]): Promise<void> {
  if (worktreeIds.length === 0) {
    return
  }
  const {
    activeWorktreeId,
    setActiveWorktree,
    shutdownWorktreeBrowsers,
    shutdownWorktreeTerminals
  } = useAppStore.getState()
  let activeSleepIntentWorktreeId: string | null = null
  if (activeWorktreeId && worktreeIds.includes(activeWorktreeId)) {
    const restoreSidebarPosition = preserveSidebarWorktreePosition(activeWorktreeId)
    // Why: clearing the active workspace can unmount TerminalPanes before
    // shutdownWorktreeTerminals writes PTY suppressions. Use a non-rendering
    // intent marker so those exits do not stamp activity, without inserting an
    // extra Zustand update that can disturb the sidebar's scroll restoration.
    markWorktreeSleepIntent(activeWorktreeId)
    activeSleepIntentWorktreeId = activeWorktreeId
    setActiveWorktree(null)
    restoreSidebarPosition()
  }
  const errors: string[] = []
  const failedWorktreeIds = new Set<string>()
  try {
    for (const worktreeId of worktreeIds) {
      try {
        // Why: sleep mirrors removeWorktree's shutdown sequence — browsers first
        // so destroyPersistentWebview unregisters the Chromium guests before any
        // other teardown runs, terminals second so the PTY kill uses the same
        // ordering on both paths. Without the browser thunk here, sleep leaks
        // browserPagesByWorkspace entries and live webviews for the slept worktree.
        await shutdownWorktreeBrowsers(worktreeId)
      } catch (err) {
        console.error('[sleep-worktree] browser shutdown failed', { worktreeId, error: err })
        failedWorktreeIds.add(worktreeId)
        errors.push(describeSleepFailure(err))
        continue
      }
      try {
        // Why: sleep is reversible — the tab record stays in tabsByWorktree, the
        // layout stays in terminalLayoutsByTabId, only the live PTY processes are
        // released. keepIdentifiers preserves tab.ptyId / ptyIdsByLeafId /
        // lastKnownRelayPtyIdByTabId so wake re-spawns against the same on-disk
        // history dir (local) or relay session id (SSH); it also captures
        // serializer buffers into buffersByLeafId for SSH wake to reseed
        // scrollback. See DESIGN_DOC_TERMINAL_HISTORY_FIX_V2.md §3.3.c.
        await shutdownWorktreeTerminals(worktreeId, { keepIdentifiers: true })
        if (typeof window !== 'undefined' && window.api?.ephemeralVm?.suspendWorkspace) {
          await window.api.ephemeralVm.suspendWorkspace({ workspaceId: worktreeId })
        }
      } catch (err) {
        console.error('[sleep-worktree] terminal or host suspension failed', {
          worktreeId,
          error: err
        })
        failedWorktreeIds.add(worktreeId)
        errors.push(describeSleepFailure(err))
      }
    }
  } finally {
    if (activeSleepIntentWorktreeId) {
      clearWorktreeSleepIntent(activeSleepIntentWorktreeId)
      if (failedWorktreeIds.has(activeSleepIntentWorktreeId)) {
        // Why: any failed sleep step must leave the workspace visible and retryable.
        setActiveWorktree(activeSleepIntentWorktreeId)
      }
    }
  }
  if (errors.length > 0) {
    // Why: callers are fire-and-forget; surface actionable teardown failures after restoring retryable UI state.
    toast.error(
      worktreeIds.length === 1
        ? translate(
            'auto.components.sidebar.sleep.worktree.flow.8bc3fc0671',
            'Failed to sleep workspace'
          )
        : translate(
            'auto.components.sidebar.sleep.worktree.flow.c460fecc4a',
            'Failed to sleep some workspaces'
          ),
      {
        description: errors.join('\n')
      }
    )
  }
}
