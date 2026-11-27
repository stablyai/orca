import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { activateStructuredAgentSessionTab } from '@/lib/agent-session/structured-agent-session-tab-activation'
import { activateAndRevealWorkspace } from '@/lib/workspace/activation/worktree-activation'
import {
  structuredAgentSessionOwnerForTab,
  structuredAgentSessionTargetForTab
} from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { NativeChatComposerNotice } from './native-chat-composer-notice'
import {
  noteNativeChatFilesHeldElsewhere,
  noteNativeChatHeldOwnerUnreachable,
  readNativeChatHeldElsewhere,
  subscribeToNativeChatHeldElsewhere,
  type NativeChatHeldElsewhere,
  type NativeChatHeldElsewhereRecord
} from './native-chat-held-elsewhere-notice'
import { nativeChatHeldElsewhereSentence } from './native-chat-held-elsewhere-sentence'
import {
  nativeChatHeldElsewhereAt,
  nativeChatHeldElsewhereNow
} from '../../attachments/native-chat-browser-file-refusal'
import { nativeChatBrowserFileRefusalParts } from '../../attachments/native-chat-browser-file-references'
import { agentSessionWriteNoticeText } from '../../messages/notices/agent-session-write-notice-text'
import {
  nativeChatStagedOwnershipVersion,
  subscribeToNativeChatStagedOwnership
} from '../../drafts/native-chat-staged-ownership'

/**
 * One line: the message wasn't sent, and how many of its files are still in which chat's draft, with
 * a button to open that chat. Files in more than one chat, or in no open chat, name none and offer
 * nothing. The chat name truncates and the button stacks under a narrow row, so the text stays one line.
 */
export function nativeChatHeldElsewhereNotice(
  held: NativeChatHeldElsewhere,
  owner: { label: string; open: () => void } | null,
  dismiss: () => void
): NativeChatComposerNotice {
  const base = { key: 'held-elsewhere', kind: 'error', onDismiss: dismiss } as const
  if (held.severalChats) {
    return {
      ...base,
      text: translate(
        'components.native-chat.composer.heldInOtherChats',
        'Not sent — attachments in other chats'
      )
    }
  }
  if (!owner) {
    return {
      ...base,
      text: translate(
        'components.native-chat.composer.heldInAnotherChat',
        'Not sent — {{count}} attachments in another chat',
        {
          count: held.count,
          defaultValue_one: 'Not sent — {{count}} attachment in another chat'
        }
      )
    }
  }
  const sentence = nativeChatHeldElsewhereSentence(
    (chat) =>
      translate(
        'components.native-chat.composer.heldInOtherChat',
        'Not sent — {{count}} attachments in {{chat}}',
        {
          count: held.count,
          chat,
          defaultValue_one: 'Not sent — {{count}} attachment in {{chat}}'
        }
      ),
    owner.label
  )
  return {
    ...base,
    ...sentence,
    stackActionWhenNarrow: true,
    action: {
      label: translate('components.native-chat.composer.openOwningChat', 'Open chat'),
      onClick: owner.open
    }
  }
}

/**
 * The one open chat tab of `sessionId`. Two tabs of the same conversation (a paired twin of it) are
 * ambiguous: the notice names and opens neither rather than guess.
 */
export function nativeChatHeldElsewhereOwnerTab(
  tabsByWorktree: Readonly<Record<string, readonly Tab[]>>,
  sessionId: string
): Tab | null {
  let found: Tab | null = null
  for (const tabs of Object.values(tabsByWorktree)) {
    for (const tab of tabs) {
      if (tab.contentType === 'agent-session' && tab.entityId === sessionId) {
        if (found) {
          return null
        }
        found = tab
      }
    }
  }
  return found
}

/** Reveal the owning chat where it lives (its workspace, on its host) and select it; false if not. */
function openOwnerChat(tab: Tab): boolean {
  const state = useAppStore.getState()
  const target = structuredAgentSessionTargetForTab(state, tab)
  if (!target) {
    return false
  }
  const owner = structuredAgentSessionOwnerForTab(state, tab)
  if (
    activateAndRevealWorkspace(tab.worktreeId, owner ? { executionHostId: owner } : undefined) ===
    false
  ) {
    return false
  }
  return activateStructuredAgentSessionTab({ worktreeId: tab.worktreeId, tabId: tab.id, target })
}

const NO_SUBSCRIPTION = (): (() => void) => () => {}

/**
 * The chat whose draft holds the files now, as the drafts and the open tabs say at this moment, unless
 * this notice already failed to open it.
 */
function currentOwner(
  record: NativeChatHeldElsewhereRecord,
  held: NativeChatHeldElsewhere | null,
  tabsByWorktree: Readonly<Record<string, readonly Tab[]>> | null
): Tab | null {
  const ownerSessionId = held?.ownerSessionId
  if (!ownerSessionId || !tabsByWorktree || ownerSessionId === record.unreachableOwner) {
    return null
  }
  return nativeChatHeldElsewhereOwnerTab(tabsByWorktree, ownerSessionId)
}

/** This chat's persistent account of a refused message whose files another chat's draft held. */
export function useNativeChatHeldElsewhereNotice(
  sessionId: string | undefined
): NativeChatComposerNotice | null {
  const subscribe = useCallback(
    (listener: () => void) =>
      sessionId ? subscribeToNativeChatHeldElsewhere(sessionId, listener) : NO_SUBSCRIPTION(),
    [sessionId]
  )
  const record = useSyncExternalStore(subscribe, () =>
    sessionId ? readNativeChatHeldElsewhere(sessionId) : null
  )
  // Who holds the files is read from the drafts, and heard again whenever that can change, but only
  // while there is a notice to say it.
  const subscribeOwnership = useCallback(
    (listener: () => void) =>
      record ? subscribeToNativeChatStagedOwnership(listener) : NO_SUBSCRIPTION(),
    [record]
  )
  const ownershipVersion = useSyncExternalStore(subscribeOwnership, () =>
    record ? nativeChatStagedOwnershipVersion() : 0
  )
  // The same result object until the record or the drafts' ownership changes.
  const now =
    record && sessionId ? nativeChatHeldElsewhereAt(record, sessionId, ownershipVersion) : null
  const ownerSessionId = now?.held?.ownerSessionId
  // Why the map itself, and only while an owner is named: unrelated store writes keep its identity, so
  // they neither re-render nor rescan; the scan below runs once per tab-set change.
  const tabsByWorktree = useAppStore((state) =>
    ownerSessionId ? state.unifiedTabsByWorktree : null
  )
  const tab = useMemo(
    () => (record && now ? currentOwner(record, now.held, tabsByWorktree) : null),
    [record, now, tabsByWorktree]
  )
  return useMemo((): NativeChatComposerNotice | null => {
    if (!record || !now || !sessionId) {
      return null
    }
    const dismiss = () => noteNativeChatFilesHeldElsewhere(sessionId, null)
    if (now.held) {
      const owner = tab
        ? {
            label: tab.customLabel || tab.label,
            open: () => {
              // Read again at the click: the drafts or tabs may have changed since it was shown.
              const state = useAppStore.getState()
              const latest = nativeChatHeldElsewhereNow(record.references, sessionId)
              const target = currentOwner(record, latest.held, state.unifiedTabsByWorktree)
              if (!target || !openOwnerChat(target)) {
                noteNativeChatHeldOwnerUnreachable(sessionId, tab.entityId)
              }
            }
          }
        : null
      return nativeChatHeldElsewhereNotice(now.held, owner, dismiss)
    }
    // Nobody holds them any more: the files have to be attached again, as for any file not here.
    return now.gone.length
      ? {
          key: 'held-elsewhere',
          kind: 'error',
          text: agentSessionWriteNoticeText(nativeChatBrowserFileRefusalParts(now.gone)),
          onDismiss: dismiss
        }
      : null
  }, [record, now, sessionId, tab])
}
