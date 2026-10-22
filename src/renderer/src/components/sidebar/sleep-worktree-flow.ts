import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { captureWorkspaceSelection, restoreWorkspaceSelection } from '@/lib/active-workspace-host'
import {
  clearWorktreeSleepIntent,
  hasWorktreeSleepIntent,
  markWorktreeSleepIntent,
  withWorktreeSleepTeardown
} from '@/lib/worktree-sleep-intent'
import { translate } from '@/i18n/i18n'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { preserveSidebarWorktreePosition } from './sleep-worktree-sidebar-position'
import { stopWorkspaceChats, type WorkspaceChatStop } from './sleep-workspace-chat-stop'

/** One per host asked to stop the workspace's chats. */
export type WorkspaceSleepResult = {
  workspaceId: string
  executionHostId: ExecutionHostId
  stoppedSessionIds: string[]
  /** The whole workspace slept and is still asleep. */
  completed: boolean
}

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
export async function runSleepWorktree(worktreeId: string): Promise<WorkspaceSleepResult[]> {
  return runSleepWorktrees([worktreeId])
}

function describeSleepFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  // Why first: the twin refusal names no connection problem, though it contains "terminal_".
  if (detail.includes('ambiguous_terminal_owner')) {
    return translate(
      'auto.components.sidebar.sleep.worktree.flow.twin.unattributed',
      "Orca couldn't tell which host runs this workspace's terminals, so the workspace was kept open. Reconnect its hosts and try again."
    )
  }
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

function describeChatStopFailure(): string {
  return translate(
    'auto.components.sidebar.sleep.worktree.flow.chat.partial',
    'The host could not confirm the chat stopped. Other panels may have closed; check the connection and try again.'
  )
}

export async function runSleepWorktrees(
  worktreeIds: readonly string[]
): Promise<WorkspaceSleepResult[]> {
  const { errors, results } = await sleepWorktreesReportingFailures(worktreeIds, {
    markChatsAsleep: true
  })
  if (errors.length > 0) {
    // Why: callers are fire-and-forget; surface actionable teardown failures after restoring retryable UI state.
    toast.error(
      new Set(worktreeIds).size === 1
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
  return results
}

export type WorktreeSleepOutcome = {
  /** Every workspace not verifiably slept, including one whose chat stop went unconfirmed. */
  failedWorktreeIds: string[]
  errors: string[]
  results: WorkspaceSleepResult[]
}

/** The sleep without the toast, for callers that report failures themselves. */
export async function sleepWorktreesReportingFailures(
  requestedWorktreeIds: readonly string[],
  // Why: only the user's Sleep hides its chats; a project move pauses through this core too.
  options: { markChatsAsleep?: boolean } = {}
): Promise<WorktreeSleepOutcome> {
  // Why unique: both copies of a twin share one id, and sleeping it sleeps the whole workspace.
  const worktreeIds = [...new Set(requestedWorktreeIds)]
  if (worktreeIds.length === 0) {
    return { failedWorktreeIds: [], errors: [], results: [] }
  }
  const {
    activeWorktreeId,
    setActiveWorktree,
    shutdownWorktreeBrowsers,
    shutdownWorktreeTerminals
  } = useAppStore.getState()
  const sleptActiveWorktreeId =
    activeWorktreeId && worktreeIds.includes(activeWorktreeId) ? activeWorktreeId : null
  const selectionBeforeSleep = captureWorkspaceSelection(useAppStore.getState())
  if (sleptActiveWorktreeId) {
    const restoreSidebarPosition = preserveSidebarWorktreePosition(sleptActiveWorktreeId)
    // Why: clearing the active workspace can unmount TerminalPanes before
    // shutdownWorktreeTerminals writes PTY suppressions; mark first so those
    // exits do not stamp activity. Kept off the store so it cannot disturb the
    // sidebar's scroll restoration.
    markWorktreeSleepIntent(sleptActiveWorktreeId)
    setActiveWorktree(null)
    restoreSidebarPosition()
  }
  const errors: string[] = []
  const failedWorktreeIds = new Set<string>()
  // Why apart from failedWorktreeIds: stopped terminals stay stopped when only a chat stop fails.
  const chatFailedIds = new Set<string>()
  const attempts = worktreeIds.map((worktreeId) => {
    markWorktreeSleepIntent(worktreeId)
    let chats: Promise<WorkspaceChatStop> = Promise.resolve({ receipts: [], failed: false })
    // Browser cleanup and the authoritative terminal admission run before any batch wait.
    const panels = withWorktreeSleepTeardown(worktreeId, async () => {
      shutdownWorktreeBrowsers(worktreeId)
      await shutdownWorktreeTerminals(worktreeId, {
        keepIdentifiers: true,
        onAdmitted: () => {
          chats = stopWorkspaceChats(
            useAppStore.getState(),
            worktreeId,
            options.markChatsAsleep
          ).catch((error: unknown) => {
            console.error('[sleep-worktree] native chat stop failed', { worktreeId, error })
            return { receipts: [], failed: true }
          })
        }
      })
    }).then(
      () => {
        if (useAppStore.getState().activeWorktreeId === worktreeId) {
          clearWorktreeSleepIntent(worktreeId)
        }
      },
      (error: unknown) => {
        console.error('[sleep-worktree] panel shutdown failed', { worktreeId, error })
        failedWorktreeIds.add(worktreeId)
        errors.push(describeSleepFailure(error))
      }
    )
    return { worktreeId, settled: panels.then(() => chats) }
  })
  const results: WorkspaceSleepResult[] = []
  try {
    // A VM may carry another workspace's host: settle the entire batch before suspending any.
    const chatStops = await Promise.all(attempts.map(({ settled }) => settled))
    for (const [index, { worktreeId }] of attempts.entries()) {
      const { receipts, failed } = chatStops[index]
      if (failed) {
        chatFailedIds.add(worktreeId)
        errors.push(describeChatStopFailure())
      }
      if (!failedWorktreeIds.has(worktreeId) && hasWorktreeSleepIntent(worktreeId)) {
        try {
          await withWorktreeSleepTeardown(worktreeId, async () => {
            if (typeof window !== 'undefined' && window.api?.ephemeralVm?.suspendWorkspace) {
              await window.api.ephemeralVm.suspendWorkspace({ workspaceId: worktreeId })
            }
          })
          if (useAppStore.getState().activeWorktreeId === worktreeId) {
            clearWorktreeSleepIntent(worktreeId)
          }
        } catch (error) {
          console.error('[sleep-worktree] host suspension failed', { worktreeId, error })
          failedWorktreeIds.add(worktreeId)
          errors.push(describeSleepFailure(error))
        }
      }
      results.push(
        ...receipts.map((receipt) => ({ workspaceId: worktreeId, ...receipt, completed: false }))
      )
    }
  } finally {
    // Why: a failed sleep leaves the workspace awake and retryable.
    for (const worktreeId of failedWorktreeIds) {
      clearWorktreeSleepIntent(worktreeId)
    }
    // Why still empty: a workspace the user picked during the sleep is theirs to keep.
    if (
      sleptActiveWorktreeId &&
      failedWorktreeIds.has(sleptActiveWorktreeId) &&
      useAppStore.getState().activeWorktreeId === null
    ) {
      restoreWorkspaceSelection(useAppStore.getState(), selectionBeforeSleep)
    }
  }
  return {
    failedWorktreeIds: [...new Set([...failedWorktreeIds, ...chatFailedIds])],
    errors: [...new Set(errors)],
    results: results.map((result) => ({
      ...result,
      completed:
        !failedWorktreeIds.has(result.workspaceId) &&
        !chatFailedIds.has(result.workspaceId) &&
        hasWorktreeSleepIntent(result.workspaceId)
    }))
  }
}
