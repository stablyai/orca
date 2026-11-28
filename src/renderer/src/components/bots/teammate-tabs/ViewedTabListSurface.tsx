// Another person's tabs in a shared agent's Home, over this window's own (which stay as they were):
// their strip, live from the host, on a tinted row, and the tab picked here. Picking one only shows
// it here; closing one closes it in their list, the one act on it.
import { Eye, FileText, GitCompareArrows, Globe, SquareTerminal, X } from 'lucide-react'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { agentTypeToIconAgent } from '../../../../../shared/agent-status/presentation/agent-type-icon-agent'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { useTranslate } from '@/i18n/use-translate'
import { callBotRpc } from '@/lib/bot-hosts'
import { cn } from '@/lib/class-names'
import type { Bot } from '../../../../../shared/bot-types'
import type { RuntimeMobileSessionClientTab } from '../../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import { TabListPersonControl } from './TabListPersonControl'
import type { TabListPeople } from './tab-list-people'
import { usePersonTabList } from './use-person-tab-list'
import { ViewedTabBody } from './ViewedTabBody'
import { pickViewedTab, type ViewedTabList } from './viewed-tab-list'

/** Each kind's icon as their own strip draws it: the agent a chat or terminal runs, a file's mode. */
function TabIcon({ tab }: { tab: RuntimeMobileSessionClientTab }): React.JSX.Element {
  const className = 'mr-1 size-3 shrink-0 text-muted-foreground'
  switch (tab.type) {
    case 'agent-session':
      return (
        <span className="mr-1 inline-flex shrink-0">
          <AgentIcon agent={agentTypeToIconAgent(tab.agent)} size={12} />
        </span>
      )
    case 'terminal':
      return tab.launchAgent ? (
        <span className="mr-1 inline-flex shrink-0">
          <AgentIcon agent={tab.launchAgent} size={12} />
        </span>
      ) : (
        <SquareTerminal className={className} />
      )
    case 'browser':
      return <Globe className={className} />
    case 'file':
    case 'markdown': {
      const ModeIcon =
        tab.mode === 'diff' ? GitCompareArrows : tab.mode === 'markdown-preview' ? Eye : FileText
      return <ModeIcon className={className} />
    }
  }
}

function ViewedTab({
  tab,
  title,
  active,
  onPick,
  onClose
}: {
  tab: RuntimeMobileSessionClientTab
  title: string
  active: boolean
  onPick: () => void
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  // A pinned tab (their Home chat) stays in their list, as it does in their own strip.
  const closeable = tab.isPinned !== true
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={!closeable}>
        <div
          role="tab"
          aria-selected={active}
          onMouseDown={(event) => event.button === 0 && onPick()}
          className={cn(
            'group relative flex h-full w-[140px] shrink-0 cursor-pointer items-center border-r border-border px-1.5 text-xs select-none',
            active
              ? 'bg-tab-active text-tab-active-foreground'
              : 'bg-tab-inactive text-tab-inactive-foreground hover:text-tab-active-foreground'
          )}
        >
          {active ? (
            <span className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-[2px] bg-tab-active-indicator" />
          ) : null}
          <TabIcon tab={tab} />
          <span className="mr-1 min-w-0 flex-1 truncate">{title}</span>
          {closeable ? (
            <button
              type="button"
              aria-label={t('bots.teammateTabs.closeTab', 'Close {{title}}', { title })}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={onClose}
              className={cn(
                'relative z-10 flex size-4 shrink-0 items-center justify-center rounded-sm',
                active
                  ? 'text-muted-foreground hover:bg-muted hover:text-foreground'
                  : 'text-transparent group-hover:text-muted-foreground'
              )}
            >
              <X className="size-3" />
            </button>
          ) : null}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-52">
        <ContextMenuItem onSelect={onClose}>
          <X />
          {t('bots.teammateTabs.close', 'Close')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

export function ViewedTabListSurface({
  bot,
  homeKey,
  view,
  people,
  holderName
}: {
  bot: Bot
  homeKey: string
  view: ViewedTabList
  people: TabListPeople
  /** Whose list it is, as the person control names them. */
  holderName: string
}): React.JSX.Element {
  const t = useTranslate()
  const read = usePersonTabList(bot, homeKey, view.person)
  const tabs = read.state === 'ready' ? read.list.tabs : []
  const picked = view.picked
  const shown =
    tabs.find((tab) =>
      picked === null
        ? false
        : 'tabId' in picked
          ? tab.id === picked.tabId
          : tab.type === 'agent-session' && tab.sessionId === picked.sessionId
    ) ??
    tabs.find((tab) => read.state === 'ready' && tab.id === read.list.theirActiveTabId) ??
    tabs[0] ??
    null
  const close = (tab: RuntimeMobileSessionClientTab): void => {
    void callBotRpc(bot, 'session.tabs.close', {
      worktree: `id:${homeKey}`,
      tabId: tab.id,
      reason: 'user',
      person: view.person
    }).catch((error: unknown) => console.warn('[teammate-tabs] close failed', error))
  }
  return (
    <div
      className="absolute inset-0 z-30 flex flex-col bg-background"
      data-viewed-tab-list={view.person === 'owner' ? 'owner' : view.person.accountId}
    >
      <div className="@container/tab-strip relative flex h-8 flex-none items-stretch border-b border-foreground/20 bg-card">
        <div className="pointer-events-none absolute inset-0 bg-foreground/5" />
        <TabListPersonControl homeKey={homeKey} people={people} />
        <div
          role="tablist"
          className="terminal-tab-strip relative flex h-full min-w-0 shrink items-stretch overflow-x-auto overflow-y-hidden"
        >
          {tabs.map((tab) => (
            <ViewedTab
              key={tab.id}
              tab={tab}
              // Their Home chat, named as whose it is, since this window's own Home is "Home".
              title={
                tab.type === 'agent-session' && tab.isPinned
                  ? t('bots.teammateTabs.home', '{{name}}’s Home', { name: holderName })
                  : tab.title
              }
              active={tab.id === shown?.id}
              onPick={() => pickViewedTab(homeKey, { tabId: tab.id })}
              onClose={() => close(tab)}
            />
          ))}
        </div>
      </div>
      {shown ? (
        <ViewedTabBody key={shown.id} bot={bot} tab={shown} holderName={holderName} />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
          {read.state === 'failed'
            ? t('bots.teammateTabs.unavailable', 'Their tabs can’t be read right now.')
            : read.state === 'loading'
              ? null
              : t('bots.teammateTabs.empty', '{{name}} has no tabs open here.', {
                  name: holderName
                })}
        </div>
      )}
      <div className="pointer-events-none absolute inset-0 z-40 ring-1 ring-foreground/15 ring-inset" />
    </div>
  )
}
