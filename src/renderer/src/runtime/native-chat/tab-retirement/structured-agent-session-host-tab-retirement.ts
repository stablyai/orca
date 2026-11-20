import { readBots, readBotsEnabled } from '@/lib/bot-catalog'
import {
  botHostEndsChats,
  requestBotChatEnd,
  showBotChatTabCloseResult
} from '@/components/bots/bot-chat-end'
import { botOfHomeWorkspace } from '../../../../../shared/bots/bot-homes'
import { chatTabShowing } from './chat-tab-showings'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { retireStructuredAgentSessionReadOwner } from '@/components/native-chat/session/structured/read/structured-agent-session-read-owner-registry'
import { forgetStructuredSessionSelection } from '@/lib/agent-session/options/structured-agent-session-selection-controller'
import { closeStructuredAgentSession } from '../requests/structured-agent-session-close'
import { withLocalSessionTabCloseOwner } from '../../web-session-tabs-sync/closing/local-session-tab-close-owner'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'
import { toRuntimeWorktreeSelector } from '../../rpc/targets/runtime-worktree-selector'

const inFlightRetirements = new Map<string, Promise<boolean>>()

/** A bot side chat's "x" asks its host once: it ends the chat when nothing is left, else keeps it in
 *  the background as before. Null when the host can't (older host, no showing yet) or it is the Home. */
function closeBotSideChatTab(args: {
  target: RuntimeClientTarget
  worktreeId: string
  sessionId: string
  onError?: (error: unknown) => void
}): Promise<boolean> | null {
  const bot = readBotsEnabled() ? botOfHomeWorkspace(readBots(), args.worktreeId) : null
  const showing = chatTabShowing(args.target, args.worktreeId, args.sessionId)
  if (!bot || !showing || bot.chatSessionId === args.sessionId || !botHostEndsChats(bot)) {
    return null
  }
  return requestBotChatEnd(bot, { chat: args.sessionId, intent: 'x', showing })
    .then((result) => {
      showBotChatTabCloseResult(bot, args.sessionId, result)
      return result.outcome === 'ended' || ('background' in result && result.background === true)
    })
    .catch((error: unknown) => {
      args.onError?.(error)
      return false
    })
}

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
  const botClose = closeBotSideChatTab(args)
  if (botClose) {
    const settled = botClose.finally(() => inFlightRetirements.delete(key))
    inFlightRetirements.set(key, settled)
    return settled
  }
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
  const promise = Promise.allSettled([
    closeStructuredAgentSession(args.target, args.sessionId),
    closeHostTab()
  ]).then((results) => {
    inFlightRetirements.delete(key)
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
  inFlightRetirements.set(key, promise)
  return promise
}
