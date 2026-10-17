import { useAppStore } from '@/store'
import { activateAiVaultStructuredSession } from '@/lib/activate-ai-vault-structured-session'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { captureNativeChatComposerFocusIntent } from '@/components/native-chat/use-native-chat-composer-reveal-focus'
import {
  aiVaultHistoryAgents,
  type AiVaultAgent,
  type AiVaultSession
} from '../../../../shared/ai-vault-types'
import { adoptsCliConversations } from '../../../../shared/structured-agent-cli-conversation-adoption'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import type { Tab } from '../../../../shared/tab-types'
import { getStructuredAgentSessionLaunchLifecycle } from '@/lib/structured-agent-session-launch-registry'
import { structuredLaunchConversationOwner } from '@/lib/structured-agent-session-launch-failure'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/structured-agent-session-status-feed'
import type { AiVaultSessionRowChatActions } from './ai-vault-session-chat-action'
import { resumeAiVaultSessionInNewChat } from './ai-vault-session-resume-in-chat-launch'
import {
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey
} from '../native-chat/native-chat-composer-draft-store'

/** The chat `/resume` was typed in; a picked row's conversation takes its place. */
export type AiVaultResumeHere = {
  tabId: string
  workspaceId: string
  /** The chat's agent; another agent's conversation can't continue in it. */
  agent?: AiVaultAgent
  /** Picking the chat's own conversation only closes the picker; a no-op once it has closed. */
  dismiss: () => void
}

/**
 * A tab is one conversation, so "resume here" opens the picked conversation's own chat right after
 * this one and closes this one once that chat exists. False: the row can't take this chat's place;
 * otherwise the pick settles once its outcome is known.
 */
export function resumeAiVaultSessionHere(args: {
  session: AiVaultSession
  here: AiVaultResumeHere
  actions: Pick<
    AiVaultSessionRowChatActions,
    'canJumpToOriginalPane' | 'resumeInNewChatWorkspaceId'
  >
  jump: (session: AiVaultSession) => void
}): false | Promise<void> {
  const { session, here, actions } = args
  const structured = session.structuredSession
  if (structured && structured.sessionId === findChatTab(here)?.entityId) {
    here.dismiss()
    return Promise.resolve()
  }
  // One conversation never runs in two chats, so one already open is switched to.
  if (actions.canJumpToOriginalPane) {
    args.jump(session)
    return Promise.resolve()
  }
  if (!here.agent || !aiVaultHistoryAgents(here.agent).includes(session.agent)) {
    return false
  }
  if (structured) {
    if (structured.workspaceId !== here.workspaceId) {
      return false
    }
    return activateAiVaultStructuredSession(session).then(() => {
      // It also settles true after a reopen it could only report, so only a tab that exists replaces.
      if (findChatTabWhere(here.workspaceId, (tab) => tab.entityId === structured.sessionId)) {
        closeReplacedChat(here)
      }
    })
  }
  if (
    actions.resumeInNewChatWorkspaceId !== here.workspaceId ||
    !adoptsCliConversations(session.agent)
  ) {
    return false
  }
  const focus = captureNativeChatComposerFocusIntent()
  let openedTabId: string | null = null
  let resolve = (): void => undefined
  const settled = new Promise<void>((settle) => {
    resolve = settle
  })
  void resumeAiVaultSessionInNewChat(
    session,
    session.agent,
    here.workspaceId,
    newAgentLaunchRequestId(),
    {
      afterTabId: here.tabId,
      // Why: the focus request is the one call every launch path makes once the new tab exists.
      focusIntent: {
        request: (tabId) => {
          openedTabId = tabId
          focus.request(tabId)
        },
        cancel: focus.cancel
      },
      onSettled: (settlement) => {
        // A row listed before its chat took it over lacks the link; the host's refusal names that chat.
        const owner =
          settlement?.kind === 'failed'
            ? structuredLaunchConversationOwner(settlement.error)
            : undefined
        if (owner && owner.sessionId === findChatTab(here)?.entityId) {
          here.dismiss()
        } else if (owner) {
          void activateAiVaultStructuredSession({ structuredSession: owner })
        }
        if (settlement?.kind === 'structured') {
          closeReplacedChat(here)
        } else if (settlement?.kind === 'failed' && openedTabId) {
          // A refusal is toasted, so its tab goes and the group falls back to the chat it would
          // replace. An unknown outcome keeps both: that tab has its own badge and Retry.
          useAppStore.getState().closeUnifiedTab(openedTabId)
        }
        resolve()
        return owner !== undefined
      }
    }
  )
  return settled
}

function findChatTabWhere(workspaceId: string, matches: (tab: Tab) => boolean): Tab | undefined {
  return useAppStore
    .getState()
    .unifiedTabsByWorktree[workspaceId]?.find(
      (tab) => tab.contentType === 'agent-session' && matches(tab)
    )
}

function findChatTab(here: AiVaultResumeHere): Tab | undefined {
  return findChatTabWhere(here.workspaceId, (tab) => tab.id === here.tabId)
}

function closeReplacedChat(here: AiVaultResumeHere): void {
  const state = useAppStore.getState()
  const tab = findChatTab(here)
  if (!tab || tab.isPinned) {
    return
  }
  // Why: closing a chat stops its agent, so only a finished turn or an untouched chat closes; one
  // replying, asking or still starting stays open beside the new chat, as does an unsent draft.
  const status = state.agentStatusByPaneKey[structuredAgentSessionPaneKey(tab.id, tab.entityId)]
  const settled = status ? status.state === 'done' : isUntouchedChat(here.workspaceId, tab)
  const draft = readNativeChatComposerDraft(structuredAgentSessionDraftScopeKey(tab.entityId))
  if (settled && draft.text.trim() === '' && draft.images.length === 0) {
    state.closeUnifiedTab(tab.id)
  }
}

/** Its launch finished and its host, observed live, reports no message and no starting child. */
function isUntouchedChat(workspaceId: string, tab: Tab): boolean {
  const lifecycle = getStructuredAgentSessionLaunchLifecycle(workspaceId, tab.entityId)
  // The host stamped on the tab; an unstamped one can't be read, so it counts as busy.
  const target = structuredAgentSessionTargetForHost(tab.executionHostId)
  if ((lifecycle !== null && lifecycle !== 'published') || !target) {
    return false
  }
  const feed = getStructuredAgentSessionStatusFeed(target)
  const summary = feed.getSnapshot().get(tab.entityId)
  return (
    feed.getSessionObservation(tab.entityId) === 'live' &&
    summary?.status === null &&
    summary.hostExecutionPhase !== 'starting'
  )
}
