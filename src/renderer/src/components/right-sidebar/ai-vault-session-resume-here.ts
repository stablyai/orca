import { admitStructuredAgentSession } from '@/lib/agent-session/structured-agent-session-busy'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import { useAppStore } from '@/store'
import {
  activateAiVaultStructuredSession,
  structuredSessionOpenFeedback
} from '@/lib/activate-ai-vault-structured-session'
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
import type { Tab } from '../../../../shared/tab-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { structuredLaunchConversationOwner } from '@/lib/structured-agent-session-launch-failure'
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

type AiVaultReplacement = AiVaultResumeHere & { current: () => boolean }

/** Replace this chat only after the picked chat opens; confirm busy chats first. False means the row cannot replace it. */
export function resumeAiVaultSessionHere(args: {
  session: AiVaultSession
  here: AiVaultResumeHere
  actions: Pick<
    AiVaultSessionRowChatActions,
    'canJumpToOriginalPane' | 'resumeInNewChatWorkspaceId'
  >
  jump: (session: AiVaultSession) => void
}): false | Promise<void> {
  const { session, actions } = args
  let current = (): boolean => true
  const here = { ...args.here, current: () => current() }
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
  const target = session.executionHostId
    ? structuredAgentSessionTargetForHost(session.executionHostId)
    : undefined
  let replace: () => Promise<void>
  if (structured) {
    if (structured.workspaceId !== here.workspaceId) {
      return false
    }
    if (target === null) {
      structuredSessionOpenFeedback.hostCannotOpen()
      return Promise.resolve()
    }
    replace = () => revealInPlaceOf(here, structured, target)
  } else if (
    actions.resumeInNewChatWorkspaceId === here.workspaceId &&
    adoptsCliConversations(session.agent)
  ) {
    if (target === null) {
      structuredSessionOpenFeedback.hostCannotOpen()
      return Promise.resolve()
    }
    const rowAgent = session.agent
    replace = () => resumeInPlaceOf(here, session, rowAgent, target)
  } else {
    return false
  }
  const agent = here.agent
  const chat = findChatTab(here)
  if (!chat) {
    return replace()
  }
  const confirmReplace = (signal: AbortSignal) =>
    here.confirm({
      title: translate('components.native-chat.resumeCommand.replaceTitle', 'Replace this chat?'),
      description: translate(
        'components.native-chat.resumeCommand.replaceDescription',
        'Resuming “{{title}}” here will stop what {{agent}} is doing in this chat.',
        { title: session.title, agent: agentLabel(agent) }
      ),
      confirmLabel: translate('components.native-chat.resumeCommand.replace', 'Replace'),
      confirmVariant: 'destructive',
      initialFocus: 'confirm',
      compact: true,
      ignoresOpeningGesture: true,
      signal
    })
  return admitStructuredAgentSession(
    here.workspaceId,
    chat,
    `replace:${session.id}`,
    (busy, attempt) => {
      current = attempt.current
      const perform = (): Promise<void> | void => (current() ? replace() : undefined)
      if (!busy) {
        return perform()
      }
      here.dismiss()
      return confirmReplace(attempt.signal).then((confirmed) => {
        if (confirmed) {
          return perform()
        }
        if (current()) {
          requestNativeChatComposerFocus(chat.id)
        }
      })
    }
  )
}

function resumeInPlaceOf(
  here: AiVaultReplacement,
  session: AiVaultSession,
  rowAgent: CliConversationRowAgent,
  target: RuntimeClientTarget | undefined
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
            ? activateAiVaultStructuredSession({ structuredSession: owner }, undefined, target)
            : revealInPlaceOf(here, owner, target)
        }
        if (
          settlement?.kind === 'structured' &&
          openedTabId &&
          findChatTabWhere(here.workspaceId, (tab) => tab.id === openedTabId)
        ) {
          closeReplacedChat(here)
        } else if (settlement?.kind === 'failed' && openedTabId) {
          // Remove toasted refusal tabs; unknown outcomes retain their own badge and Retry alongside the old chat.
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
  here: AiVaultReplacement,
  structured: NonNullable<AiVaultSession['structuredSession']>,
  target: RuntimeClientTarget | undefined
): Promise<void> {
  return activateAiVaultStructuredSession(
    { structuredSession: structured },
    undefined,
    target
  ).then(() => {
    // Reported reopen success may lack a tab; replace this chat only when the reopened tab exists.
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

function closeReplacedChat(here: AiVaultReplacement): void {
  const tab = findChatTab(here)
  if (tab && here.current()) {
    // Direct close: the pin prompt belongs to the close commands, and this replacement was chosen.
    useAppStore.getState().closeUnifiedTab(tab.id)
  }
}
