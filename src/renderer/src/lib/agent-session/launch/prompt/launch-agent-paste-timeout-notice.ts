import { useAppStore } from '@/store'
import { track, tuiAgentToAgentKind } from '@/lib/telemetry'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../../../shared/non-secure-context-uuid'
import { keepGeneratedInputNotice } from '../../../generated-paste-notice'
import { showGeneratedInputNotice } from '../../../generated-input-notice-toast'
import { projectFallbackGeneratedInputNotice } from '@/runtime/generated-input-notice-toast-projection'

export { showGeneratedInputNotice }

/** A producer's failure notice: kept by this window's runtime, which survives a reload and shows
 *  it through the notice feed. When that runtime's answer does not come in time, the same
 *  operation is shown directly under its own id, so a late answer refines that one notice and its
 *  Dismiss discards the operation itself. A slow answer is never a second operation. */
export function noticeGeneratedInputFailure(
  args: Parameters<typeof showGeneratedInputNotice>[0] & { operationId?: string }
): void {
  const operationId = args.operationId ?? createBrowserUuid()
  void keepGeneratedInputNotice({ ...args, operationId }).then((kept) => {
    if (!kept) {
      projectFallbackGeneratedInputNotice({
        operationId,
        text: args.text,
        agent: args.agent,
        certainty: args.certainty,
        submitted: args.submitted
      })
    }
  })
}

export function createPasteReadinessTimeoutNotice(args: {
  worktreeId: string
  tabId: string
  agent: TuiAgent
  submitted: boolean
  content: string
  operationId?: string
}): {
  onTimeout: (
    certainty?: 'not-sent' | 'unconfirmed',
    retained?: boolean,
    operationId?: string
  ) => void
  wasNotified: () => boolean
} {
  let notified = false
  return {
    wasNotified: () => notified,
    // `retained`: the host keeps this notice in its runtime session, so it is not shown twice.
    // `operationId`: the request this failure ends, when it was accepted after this notice was made.
    onTimeout: (certainty = 'not-sent', retained = false, operationId = args.operationId) => {
      if (notified) {
        return
      }
      const tab = (useAppStore.getState().tabsByWorktree[args.worktreeId] ?? []).find(
        (candidate) => candidate.id === args.tabId
      )
      if (tab?.ptyId === null) {
        // The pane never spawned: a launch failure, which its caller reports as the sole notice.
        return
      }
      notified = true
      if (!retained) {
        noticeGeneratedInputFailure({
          agent: args.agent,
          text: args.content,
          certainty,
          submitted: args.submitted,
          operationId
        })
      }
      track('agent_error', {
        error_class: 'paste_readiness_timeout',
        agent_kind: tuiAgentToAgentKind(args.agent)
      })
    }
  }
}
