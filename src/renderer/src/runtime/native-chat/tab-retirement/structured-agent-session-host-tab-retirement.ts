import { botSideChatTab, closeBotSideChatTab } from './bot-side-chat-tab-close'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { retireStructuredAgentSessionReadOwner } from '@/components/native-chat/session/structured/read/structured-agent-session-read-owner-registry'
import { forgetStructuredSessionSelection } from '@/lib/agent-session/options/structured-agent-session-selection-controller'
import { closeStructuredAgentSession } from '../requests/structured-agent-session-close'
import { withLocalSessionTabCloseOwner } from '../../web-session-tabs-sync/closing/local-session-tab-close-owner'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'
import { toRuntimeWorktreeSelector } from '../../rpc/targets/runtime-worktree-selector'

const inFlightRetirements = new Map<string, Promise<boolean>>()

function retirementKey(target: RuntimeClientTarget, worktreeId: string, sessionId: string): string {
  return `${target.kind}:${target.kind === 'environment' ? target.environmentId : 'local'}:${worktreeId}:${sessionId}`
}

/**
 * Best-effort host cleanup; local removal must never wait for bookkeeping. Resolves false when the
 * host tab close failed, so the host may still list the chat.
 */
export function retireStructuredAgentSessionTab(args: {
  target: RuntimeClientTarget
  worktreeId: string
  sessionId: string
  onError?: (error: unknown) => void
}): Promise<boolean> {
  retireStructuredAgentSessionReadOwner(args.sessionId, args.target)
  forgetStructuredSessionSelection(args.sessionId, args.target)
  const key = retirementKey(args.target, args.worktreeId, args.sessionId)
  const existing = inFlightRetirements.get(key)
  if (existing) {
    return existing
  }
  const plainClose = () => closeThroughHost(args)
  const botTab = botSideChatTab(args)
  const promise = (botTab ? closeBotSideChatTab(args, botTab, plainClose) : plainClose()).finally(
    () => inFlightRetirements.delete(key)
  )
  inFlightRetirements.set(key, promise)
  return promise
}

/** The chat's close and its host tab's close, as for any chat. */
function closeThroughHost(args: {
  target: RuntimeClientTarget
  worktreeId: string
  sessionId: string
  onError?: (error: unknown) => void
}): Promise<boolean> {
  const hostTabId = `agent-session:${args.sessionId}`
  // Why: main echoes the host tab id it was asked to close, never this window's tab id.
  const closeHostTab = () =>
    withLocalSessionTabCloseOwner(args.worktreeId, hostTabId, () =>
      callRuntimeRpc(args.target, 'session.tabs.close', {
        worktree: toRuntimeWorktreeSelector(args.worktreeId),
        tabId: hostTabId,
        reason: 'user'
      })
    )
  return Promise.allSettled([
    closeStructuredAgentSession(args.target, args.sessionId),
    closeHostTab()
  ]).then((results) => {
    for (const result of results) {
      if (result.status === 'rejected') {
        if (args.onError) {
          args.onError(result.reason)
        } else {
          console.warn('[structured-agent-session] host retirement failed', result.reason)
        }
      }
    }
    const [, hostTabClose] = results
    return hostTabClose.status === 'fulfilled'
  })
}
