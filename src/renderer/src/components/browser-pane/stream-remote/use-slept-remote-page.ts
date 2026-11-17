// A host-run browser page and its workspace's sleep. Pages die with the VM; the
// tab stays and gets a new host page at its URL once the sandbox is up for good, including after
// a wake pressed while the suspend was still being committed.
import { useLayoutEffect, useEffect, useMemo, useRef } from 'react'
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

/** The host answered for this page with the sandbox up for good: it (and its tab) is no longer owed. */
export function noteSleptRemotePageAnswered(page: Page & { workspaceId: string }): void {
  if (
    isBrowserSandboxUp(useAppStore.getState(), page.worktreeId, readSleepInFlight(page.worktreeId))
  ) {
    settleReopenAfterSleep(page.id)
    settleReopenAfterSleep(page.workspaceId)
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

type SleptPageLifecycle = {
  open: () => unknown
  tokens: { remotePage: string | null }
}

/**
 * The remote browser lifecycle's one hook into sleep: keeps the page owed across its VM's sleep,
 * notes when the host answers for it, and reopens it once the sandbox is up again.
 */
export function useSleptRemotePageLifecycle(
  browserTab: Page & { workspaceId: string },
  lifecycleRef: { readonly current: SleptPageLifecycle | null },
  mountedRef: { readonly current: boolean }
): {
  /** Notes that the host reported the tab's info, then runs `apply`. */
  answered: (apply: () => void) => void
  /** For a page the host reports missing: true when sleep handled it (wait or reopen), so don't close. */
  handleMissing: (clearStreamFrame: () => void) => boolean
} {
  const pageRef = useRef(browserTab)
  useLayoutEffect(() => {
    pageRef.current = browserTab
  })
  const lifecycle = useMemo<SleptPageLifecycle>(
    () => ({
      open: () => lifecycleRef.current?.open(),
      tokens: {
        get remotePage() {
          return lifecycleRef.current?.tokens.remotePage ?? null
        }
      }
    }),
    [lifecycleRef]
  )
  const isMounted = useMemo(() => () => mountedRef.current, [mountedRef])
  useReopenSleptRemotePage(
    { id: browserTab.id, worktreeId: browserTab.worktreeId },
    lifecycle,
    isMounted
  )
  return useMemo(
    () => ({
      answered: (apply) => {
        noteSleptRemotePageAnswered(pageRef.current)
        apply()
      },
      handleMissing: (clearStreamFrame) => {
        // Slept with its VM: wait, or reopen at its URL, instead of closing.
        const action = sleptRemotePageMissingAction(pageRef.current)
        if (action === 'close') {
          return false
        }
        clearStreamFrame()
        if (action === 'reopen') {
          lifecycleRef.current?.open()
        }
        return true
      }
    }),
    [lifecycleRef]
  )
}
