import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import type { PaneLayoutEditIntent } from '../../../../shared/rpc-contract/session-tabs-schemas-params'
import { terminalLayoutEqual } from '@/lib/terminal-layout-equality'
import { updateWebRuntimePaneLayout } from '@/runtime/web-runtime-session'

export type RemotePaneLayoutPusher = {
  push: (input: {
    worktreeId: string
    tabId: string
    layout: TerminalLayoutSnapshot
    intent?: PaneLayoutEditIntent
  }) => void
}

/**
 * Pane geometry is host-authoritative for remote tabs, so persists must push it — but
 * persists also fire on pane-title churn, which leaves the host-visible layout untouched.
 * Dedupe against the last push so unchanged layouts cost no remote round trip.
 */
export function createRemotePaneLayoutPusher(): RemotePaneLayoutPusher {
  let lastAttempt: {
    id: number
    worktreeId: string
    tabId: string
    snapshot: TerminalLayoutSnapshot
  } | null = null
  let nextAttemptId = 0
  return {
    push: ({ worktreeId, tabId, layout, intent }) => {
      if (
        lastAttempt?.worktreeId === worktreeId &&
        lastAttempt.tabId === tabId &&
        terminalLayoutEqual(lastAttempt.snapshot, layout)
      ) {
        return
      }
      const attempt = { id: ++nextAttemptId, worktreeId, tabId, snapshot: layout }
      lastAttempt = attempt
      void updateWebRuntimePaneLayout({
        worktreeId,
        tabId,
        root: layout.root,
        expandedLeafId: layout.expandedLeafId,
        chatLeafId: layout.chatLeafId ?? null,
        ...(layout.titlesByLeafId ? { titlesByLeafId: layout.titlesByLeafId } : {}),
        ...(intent ? { intent } : {})
      }).then((updated) => {
        // Why: a disconnected or timed-out push carried no information, so the next persist must retry it.
        if (!updated && lastAttempt?.id === attempt.id) {
          lastAttempt = null
        }
      })
    }
  }
}
