// One tab of another person's list, shown here as it is on the agent's host: their chat to read and
// reply in, their terminal (typing takes its size, as on a paired server), a browser named by the
// computer it is open on, and a file to edit with versioned saves. Showing one writes nothing to
// their list or their screen.
import { Globe } from 'lucide-react'
import NativeChatView from '@/components/native-chat/NativeChatView'
import { AgentTerminalPreview } from '@/components/dashboard/terminal-preview/AgentTerminalPreview'
import { useTranslate } from '@/i18n/use-translate'
import { botTarget } from '@/lib/bot-hosts'
import type { Bot } from '../../../../../shared/bot-types'
import { toRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import type { RuntimeMobileSessionClientTab } from '../../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import { viewedChatTabId } from '@/components/native-chat/pane/ownership/native-chat-tab-owner'
import { folderWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import { ViewedFileDiff } from './ViewedFileDiff'
import { ViewedFileEditor } from './ViewedFileEditor'

function Notice({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}

/** The holder's terminal by its handle on the agent's host. Its size follows the paired-terminal
 *  rule: only typing takes it, whoever types last holds it, and leaving gives it back. */
function ViewedTerminal({
  bot,
  tab
}: {
  bot: Pick<Bot, 'hostId'>
  tab: Extract<RuntimeMobileSessionClientTab, { type: 'terminal' }>
}): React.JSX.Element {
  const t = useTranslate()
  const target = botTarget(bot)
  const ptyId =
    target.kind === 'local'
      ? (tab.ptyId ?? null)
      : tab.terminal
        ? toRemoteRuntimePtyId(tab.terminal, target.environmentId)
        : null
  if (!ptyId) {
    return <Notice>{t('bots.teammateTabs.terminalStarting', 'This terminal is starting.')}</Notice>
  }
  return (
    <div className="relative min-h-0 flex-1 bg-background">
      <AgentTerminalPreview
        key={ptyId}
        ptyId={ptyId}
        className="absolute inset-0"
        claimsGridOnTyping
      />
    </div>
  )
}

export function ViewedTabBody({
  bot,
  tab,
  holderName
}: {
  bot: Bot
  tab: RuntimeMobileSessionClientTab
  /** Whose list it is: where their browsers are open. */
  holderName: string
}): React.JSX.Element {
  const t = useTranslate()
  switch (tab.type) {
    case 'agent-session':
      return (
        <div className="flex min-h-0 flex-1 flex-col">
          <NativeChatView
            mode="structured"
            tabId={viewedChatTabId(folderWorkspaceKey(bot.folderWorkspaceId), tab.id)}
            sessionId={tab.sessionId}
            target={botTarget(bot)}
            agent={tab.agent}
            isVisible
            isFocusedGroup
          />
        </div>
      )
    case 'terminal':
      return <ViewedTerminal bot={bot} tab={tab} />
    case 'browser':
      return (
        <Notice>
          <span className="flex flex-col items-center gap-2">
            <Globe className="size-5" />
            <span className="text-foreground">
              {t('bots.teammateTabs.browserElsewhere', 'Open on {{name}}’s computer', {
                name: holderName
              })}
            </span>
            {tab.url ? <span className="max-w-96 truncate text-xs">{tab.url}</span> : null}
          </span>
        </Notice>
      )
    case 'file':
      return tab.mode === 'diff' ? (
        <ViewedFileDiff bot={bot} tab={tab} />
      ) : (
        <ViewedFileEditor bot={bot} relativePath={tab.relativePath} />
      )
    case 'markdown':
      return tab.isUntitled ? (
        <Notice>{t('bots.teammateTabs.untitled', 'This document isn’t saved yet.')}</Notice>
      ) : (
        <ViewedFileEditor bot={bot} relativePath={tab.relativePath} />
      )
  }
}
