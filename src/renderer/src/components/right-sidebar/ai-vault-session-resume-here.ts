import { useAppStore } from '@/store'
import { activateAiVaultStructuredSession } from '@/lib/activate-ai-vault-structured-session'
import { insertUnifiedTabAfterAnchor } from '@/lib/unified-tab-anchor-insertion'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import {
  captureNativeChatComposerFocusIntent,
  requestNativeChatComposerFocus
} from '@/components/native-chat/use-native-chat-composer-reveal-focus'
import type { ConfirmationDialogContextValue } from '@/components/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'
import { agentLabel } from '../../../../shared/ai-vault-session-filters'
import {
  aiVaultHistoryAgents,
  type AiVaultAgent,
  type AiVaultSession
} from '../../../../shared/ai-vault-types'
import {
  adoptsCliConversations,
  type CliConversationRowAgent
} from '../../../../shared/structured-agent-cli-conversation-adoption'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import type { Tab } from '../../../../shared/tab-types'
import { getStructuredAgentSessionLaunchLifecycle } from '@/lib/structured-agent-session-launch-registry'
import { structuredLaunchConversationOwner } from '@/lib/structured-agent-session-launch-failure'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/structured-agent-session-status-feed'
import type { AiVaultSessionRowChatActions } from './ai-vault-session-chat-action'
import { resumeAiVaultSessionInNewChat } from './ai-vault-session-resume-in-chat-launch'

/** The chat `/resume` was typed in; a picked row's conversation takes its place. */
export type AiVaultResumeHere = {
  tabId: string
  workspaceId: string
  /** The chat's agent; another agent's conversation can't continue in it. */
  agent?: AiVaultAgent
  /** Picking the chat's own conversation only closes the picker; a no-op once it has closed. */
  dismiss: () => void
  confirm: ConfirmationDialogContextValue
}

/**
 * A tab is one conversation, so "resume here" opens the picked conversation's own chat right after
 * this one and closes this one once that chat exists; a busy chat asks first. False: the row can't
 * take this chat's place; otherwise the pick settles once its outcome is known.
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
  let replace: () => Promise<void>
  if (structured) {
    if (structured.workspaceId !== here.workspaceId) {
      return false
    }
    replace = () => revealInPlaceOf(here, structured)
  } else if (
    actions.resumeInNewChatWorkspaceId === here.workspaceId &&
    adoptsCliConversations(session.agent)
  ) {
    const rowAgent = session.agent
    replace = () => resumeInPlaceOf(here, session, rowAgent)
  } else {
    return false
  }
  const chat = findChatTab(here)
  if (!chat || !isChatBusy(here.workspaceId, chat)) {
    return replace()
  }
  // Replacing stops the chat's agent, so a busy one asks first; the picker closes so prompts never stack.
  here.dismiss()
  return here
    .confirm({
      title: translate('components.native-chat.resumeCommand.replaceTitle', 'Replace this chat?'),
      description: translate(
        'components.native-chat.resumeCommand.replaceDescription',
        'Resuming “{{title}}” here will stop what {{agent}} is doing in this chat.',
        { title: session.title, agent: agentLabel(here.agent) }
      ),
      confirmLabel: translate('components.native-chat.resumeCommand.replace', 'Replace'),
      confirmVariant: 'destructive',
      initialFocus: 'confirm',
      compact: true,
      ignoresOpeningGesture: true
    })
    .then((confirmed) => (confirmed ? replace() : requestNativeChatComposerFocus(chat.id)))
}

function resumeInPlaceOf(
  here: AiVaultResumeHere,
  session: AiVaultSession,
  rowAgent: CliConversationRowAgent
): Promise<void> {
  const focus = captureNativeChatComposerFocusIntent()
  let openedTabId: string | null = null
  let resolve = (): void => undefined
  const settled = new Promise<void>((settle) => {
    resolve = settle
  })
  void resumeAiVaultSessionInNewChat(
    session,
    rowAgent,
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
        let ownerShown: Promise<unknown> | undefined
        if (owner && owner.sessionId === findChatTab(here)?.entityId) {
          here.dismiss()
        } else if (owner) {
          // An owner open in another tab is switched to; a closed one reopens in this chat's place.
          const elsewhere =
            owner.workspaceId !== here.workspaceId ||
            findChatTabWhere(owner.workspaceId, (tab) => tab.entityId === owner.sessionId)
          ownerShown = elsewhere
            ? activateAiVaultStructuredSession({ structuredSession: owner })
            : revealInPlaceOf(here, owner)
        }
        if (settlement?.kind === 'structured') {
          closeReplacedChat(here)
        } else if (settlement?.kind === 'failed' && openedTabId) {
          // A refusal is toasted, so its tab goes and the group falls back to the chat it would
          // replace. An unknown outcome keeps both: that tab has its own badge and Retry.
          useAppStore.getState().closeUnifiedTab(openedTabId)
        }
        void Promise.resolve(ownerShown).then(resolve, resolve)
        return owner !== undefined
      }
    }
  )
  return settled
}

/** Reopens a closed chat in place of this one, which closes only once the reopened tab exists. */
function revealInPlaceOf(
  here: AiVaultResumeHere,
  structured: NonNullable<AiVaultSession['structuredSession']>
): Promise<void> {
  return activateAiVaultStructuredSession({ structuredSession: structured }).then(() => {
    // It also settles true after a reopen it could only report, so only a tab that exists replaces.
    const reopened = findChatTabWhere(
      here.workspaceId,
      (tab) => tab.entityId === structured.sessionId
    )
    if (reopened) {
      // Reveal appends to the group; take this chat's slot as a new chat does (a no-op across splits).
      insertUnifiedTabAfterAnchor(here.workspaceId, reopened.id, here.tabId)
      closeReplacedChat(here)
    }
  })
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
  const tab = findChatTab(here)
  if (tab) {
    // Direct close: the pin prompt belongs to the close commands, and this replacement was chosen.
    useAppStore.getState().closeUnifiedTab(tab.id)
  }
}

/** Replying or asking (the status store), still starting (its launch, or its host's provider), or
 *  unobservable: a host that can't be seen live may still be running the chat's agent. */
function isChatBusy(workspaceId: string, tab: Tab): boolean {
  const paneKey = structuredAgentSessionPaneKey(tab.id, tab.entityId)
  const status = useAppStore.getState().agentStatusByPaneKey[paneKey]?.state
  if (
    (status && status !== 'done') ||
    getStructuredAgentSessionLaunchLifecycle(workspaceId, tab.entityId) === 'pending'
  ) {
    return true
  }
  const target = structuredAgentSessionTargetForHost(tab.executionHostId)
  if (!target) {
    return true
  }
  const feed = getStructuredAgentSessionStatusFeed(target)
  return (
    feed.getSessionObservation(tab.entityId) !== 'live' ||
    feed.getSnapshot().get(tab.entityId)?.hostExecutionPhase === 'starting'
  )
}
