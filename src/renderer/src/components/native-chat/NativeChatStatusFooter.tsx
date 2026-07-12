import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { NativeChatSession } from '../../../../shared/native-chat-types'
import { translate } from '../../i18n/i18n'
import { useAppStore } from '../../store'
import { resolveNativeChatFileLinkContext } from './native-chat-file-link'
import type { NativeChatStatusFooterData } from './native-chat-status-footer'
import { deriveNativeChatStatusFooter, nativeChatWorktreeName } from './native-chat-status-footer'

export function NativeChatStatusFooter({
  data
}: {
  data: NativeChatStatusFooterData
}): React.JSX.Element {
  useTranslation()

  return (
    <div
      data-testid="native-chat-status-footer"
      className="min-w-0 shrink-0 border-t border-border px-3 py-1 font-mono text-[11px] leading-4 tracking-normal text-muted-foreground"
    >
      <div data-testid="native-chat-status-primary" className="h-4 truncate whitespace-nowrap">
        {data.primary.join(' • ')}
      </div>
      <div data-testid="native-chat-status-stage" className="h-4 truncate whitespace-nowrap">
        {translate(
          'auto.components.nativeChat.statusFooter.summary',
          'stage: {{stage}} → {{next}} · Q:{{questions}} B:{{blocked}} Ag:{{agents}}',
          data
        )}
      </div>
    </div>
  )
}

export function NativeChatCodexStatusFooter({
  paneKey,
  terminalTabId,
  session
}: {
  paneKey: string
  terminalTabId: string
  session: Pick<NativeChatSession, 'agent' | 'messages' | 'metadata'>
}): React.JSX.Element {
  const agentStatus = useAppStore((state) => state.agentStatusByPaneKey[paneKey])
  const fileLinkContext = useAppStore(
    useShallow((state) => resolveNativeChatFileLinkContext(state, terminalTabId))
  )
  const changedFiles = useAppStore((state) =>
    fileLinkContext ? (state.gitStatusByWorktree[fileLinkContext.worktreeId]?.length ?? 0) : 0
  )
  const data = useMemo(
    () =>
      deriveNativeChatStatusFooter({
        agent: session.agent,
        metadata: session.metadata,
        messages: session.messages,
        agentStatus,
        worktreeName: nativeChatWorktreeName(fileLinkContext?.worktreePath),
        changedFiles
      }),
    [session, agentStatus, fileLinkContext?.worktreePath, changedFiles]
  )

  return <NativeChatStatusFooter data={data} />
}
