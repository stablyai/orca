import type { ReactNode } from 'react'
import { translate } from '@/i18n/i18n'
import { NativeChatForkContext } from './native-chat-fork-context'
import { useNativeChatFork } from './use-native-chat-fork'
import { NativeChatForkSource } from './NativeChatForkSource'
import { NativeChatContextClearFade } from './NativeChatContextClearFade'
import type { NativeChatStructuredViewProps } from './native-chat-view-types'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'

export function NativeChatForkScope({
  pane,
  worktreeId,
  controller,
  children
}: {
  pane: NativeChatStructuredViewProps | Omit<NativeChatStructuredViewProps, 'mode'>
  worktreeId: string | null | undefined
  controller: {
    epoch: string | null
    journalItems: readonly AgentJournalRenderItem[]
    readCurrent: boolean
    contextClear: { clearing: boolean }
  }
  children: ReactNode
}) {
  const fork = useNativeChatFork({
    pane,
    worktreeId,
    epoch: controller.epoch,
    items: controller.journalItems,
    ready: controller.readCurrent
  })
  return (
    <NativeChatForkContext.Provider value={fork.surface}>
      <NativeChatForkSource
        sessionId={pane.sessionId}
        worktreeId={worktreeId}
        target={pane.target}
      />
      {fork.surface?.pending ? (
        <p role="status" className="px-4 py-1 text-xs text-chat-foreground-faint">
          {translate('components.native-chat.fork.pending', 'Creating branch…')}
        </p>
      ) : null}
      {fork.error ? (
        <p role="alert" className="px-4 py-1 text-xs text-chat-warning">
          {fork.error}
        </p>
      ) : null}
      <NativeChatContextClearFade clearing={controller.contextClear.clearing}>
        {children}
      </NativeChatContextClearFade>
    </NativeChatForkContext.Provider>
  )
}
