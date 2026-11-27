import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { activateStructuredAgentSessionTab } from '@/lib/agent-session/structured-agent-session-tab-activation'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { NativeChatComposerNotice } from './native-chat-composer-notice'
import {
  noteNativeChatFilesHeldElsewhere,
  readNativeChatHeldElsewhere,
  subscribeToNativeChatHeldElsewhere,
  type NativeChatHeldElsewhere
} from './native-chat-held-elsewhere-notice'

/**
 * One line: the message wasn't sent, and how many of its files are still in which chat's draft, with
 * a button to open that chat. Without an open chat to name, it names none and offers nothing.
 */
export function nativeChatHeldElsewhereNotice(
  held: NativeChatHeldElsewhere,
  owner: { label: string; open: () => void } | null,
  dismiss: () => void
): NativeChatComposerNotice {
  const count = { count: held.count }
  return {
    key: 'held-elsewhere',
    kind: 'attachment',
    text: owner
      ? translate(
          'components.native-chat.composer.heldInOtherChat',
          'Not sent — {{count}} attachments are still in your draft in {{chat}}',
          {
            ...count,
            chat: owner.label,
            defaultValue_one: 'Not sent — {{count}} attachment is still in your draft in {{chat}}'
          }
        )
      : translate(
          'components.native-chat.composer.heldInAnotherChat',
          "Not sent — {{count}} attachments are still in another chat's draft",
          {
            ...count,
            defaultValue_one: "Not sent — {{count}} attachment is still in another chat's draft"
          }
        ),
    ...(owner
      ? {
          action: {
            label: translate('components.native-chat.composer.openOwningChat', 'Open chat'),
            onClick: owner.open
          }
        }
      : {}),
    onDismiss: dismiss
  }
}

function ownerTab(
  tabsByWorktree: Readonly<Record<string, readonly Tab[]>>,
  sessionId: string
): Tab | null {
  for (const tabs of Object.values(tabsByWorktree)) {
    const tab = tabs.find(
      (candidate) => candidate.contentType === 'agent-session' && candidate.entityId === sessionId
    )
    if (tab) {
      return tab
    }
  }
  return null
}

const NO_SUBSCRIPTION = (): (() => void) => () => {}

/** This chat's persistent account of a refused message whose files another chat's draft holds. */
export function useNativeChatHeldElsewhereNotice(
  sessionId: string | undefined
): NativeChatComposerNotice | null {
  const subscribe = useCallback(
    (listener: () => void) =>
      sessionId ? subscribeToNativeChatHeldElsewhere(sessionId, listener) : NO_SUBSCRIPTION(),
    [sessionId]
  )
  const held = useSyncExternalStore(subscribe, () =>
    sessionId ? readNativeChatHeldElsewhere(sessionId) : null
  )
  const ownerSessionId = held?.ownerSessionId
  // Why the tab itself: its identity is stable until it changes, so other tab edits don't re-render.
  const tab = useAppStore((state) =>
    ownerSessionId ? ownerTab(state.unifiedTabsByWorktree, ownerSessionId) : null
  )
  return useMemo(() => {
    if (!held || !sessionId) {
      return null
    }
    const owner = tab
      ? {
          label: tab.customLabel || tab.label,
          open: () =>
            void activateStructuredAgentSessionTab({ worktreeId: tab.worktreeId, tabId: tab.id })
        }
      : null
    return nativeChatHeldElsewhereNotice(held, owner, () =>
      noteNativeChatFilesHeldElsewhere(sessionId, null)
    )
  }, [held, sessionId, tab])
}
