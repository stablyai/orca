// One tab of another person's list, shown here as it is on the agent's host: their chat to read and
// reply in, their terminal at its own size, a browser named by the computer it is open on, and a
// file as saved on disk. Showing one writes nothing to their list or their screen.
import { useEffect, useState } from 'react'
import { Globe } from 'lucide-react'
import NativeChatView from '@/components/native-chat/NativeChatView'
import { AgentTerminalPreview } from '@/components/dashboard/terminal-preview/AgentTerminalPreview'
import { useTranslate } from '@/i18n/use-translate'
import { botTarget, callBotRpc } from '@/lib/bot-hosts'
import type { Bot } from '../../../../../shared/bot-types'
import { toRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import type { RuntimeMobileSessionClientTab } from '../../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import type { RuntimeFileReadResult } from '../../../../../shared/file-content/runtime-file-read'

function Notice({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}

/** The holder's terminal by its handle on the agent's host: never resized from here. */
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
        claimsGrid={false}
        className="absolute inset-0"
      />
    </div>
  )
}

function ViewedFile({
  bot,
  homeKey,
  relativePath
}: {
  bot: Pick<Bot, 'hostId'>
  homeKey: string
  relativePath: string
}): React.JSX.Element {
  const t = useTranslate()
  const [read, setRead] = useState<{ path: string; content: string | null; failed: boolean }>({
    path: '',
    content: null,
    failed: false
  })
  useEffect(() => {
    let live = true
    callBotRpc<RuntimeFileReadResult>(bot, 'files.read', {
      worktree: `id:${homeKey}`,
      relativePath
    })
      .then(
        (result) => live && setRead({ path: relativePath, content: result.content, failed: false })
      )
      .catch(() => live && setRead({ path: relativePath, content: null, failed: true }))
    return () => {
      live = false
    }
  }, [bot, homeKey, relativePath])
  if (read.path !== relativePath) {
    return (
      <Notice>
        {t('bots.teammateTabs.fileReading', 'Reading {{path}}…', { path: relativePath })}
      </Notice>
    )
  }
  if (read.failed || read.content === null) {
    return (
      <Notice>
        {t('bots.teammateTabs.fileUnreadable', 'Could not read {{path}}.', { path: relativePath })}
      </Notice>
    )
  }
  return (
    <div className="scrollbar-sleek min-h-0 flex-1 overflow-auto bg-background px-4 py-3 font-mono text-xs leading-5">
      {read.content.split('\n').map((text, at) => {
        // A line is named by its number: the file is read whole each time.
        const number = at + 1
        return (
          <div key={number} className="flex">
            <span className="mr-4 inline-block w-8 shrink-0 text-right text-muted-foreground select-none">
              {number}
            </span>
            <span className="min-w-0 whitespace-pre-wrap break-all">{text}</span>
          </div>
        )
      })}
    </div>
  )
}

export function ViewedTabBody({
  bot,
  homeKey,
  tab,
  holderName
}: {
  bot: Bot
  homeKey: string
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
            tabId={`viewed:${tab.id}`}
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
    case 'markdown':
      return <ViewedFile bot={bot} homeKey={homeKey} relativePath={tab.relativePath} />
  }
}
