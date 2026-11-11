// A host-run browser page and its workspace's sleep (NEW-01, LC2-P1). Pages die with the VM; the
// tab stays and gets a new host page at its URL once the sandbox is up for good, including after
// a wake pressed while the suspend was still being committed.
import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { useIsWorktreeSuspendCommitted } from '@/lib/worktree-sleep-view'
import {
  isAwaitingReopenAfterSleep,
  isBrowserSandboxUp,
  missingRemotePageAction,
  readSleepInFlight,
  settleReopenAfterSleep
} from '@/components/sidebar/workspace-actions/sleep/browser-tab-sleep'

type Page = { id: string; worktreeId: string }

/** What to do with a page the host reports missing: wait, reopen it, or close the tab. */
export function sleptRemotePageMissingAction(page: Page): 'wait' | 'reopen' | 'close' {
  const state = useAppStore.getState()
  return missingRemotePageAction({
    awaitingReopen: isAwaitingReopenAfterSleep(page.id),
    asleep: Boolean(state.asleepBrowserWorktreeIds[page.worktreeId]),
    sandboxUp: isBrowserSandboxUp(state, page.worktreeId, readSleepInFlight(page.worktreeId))
  })
}

/** The host answered for this page with the sandbox up for good: it is no longer owed. */
export function noteSleptRemotePageAnswered(page: Page): void {
  if (
    isBrowserSandboxUp(useAppStore.getState(), page.worktreeId, readSleepInFlight(page.worktreeId))
  ) {
    settleReopenAfterSleep(page.id)
  }
}

/** Opens a page owed since sleep the moment the sandbox comes up (nothing else may ask again). */
export function useReopenSleptRemotePage(
  page: Page,
  lifecycle: { open: () => unknown; tokens: { remotePage: string | null } },
  isMounted: () => boolean
): void {
  const suspendCommitted = useIsWorktreeSuspendCommitted(page.worktreeId)
  const sandboxUp = useAppStore(
    (state) =>
      !suspendCommitted &&
      isBrowserSandboxUp(state, page.worktreeId, readSleepInFlight(page.worktreeId))
  )
  const wasUpRef = useRef(sandboxUp)
  useEffect(() => {
    const cameUp = sandboxUp && !wasUpRef.current
    wasUpRef.current = sandboxUp
    if (
      cameUp &&
      isMounted() &&
      isAwaitingReopenAfterSleep(page.id) &&
      lifecycle.tokens.remotePage === null
    ) {
      lifecycle.open()
    }
  }, [isMounted, lifecycle, page.id, sandboxUp])
}
