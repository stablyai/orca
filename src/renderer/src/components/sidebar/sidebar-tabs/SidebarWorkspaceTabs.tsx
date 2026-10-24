import React, { useMemo } from 'react'
import { Bot, FileText, Globe, Plus, Smartphone, SquareTerminal, X } from 'lucide-react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { Tab } from '../../../../../shared/tab-types'
import { buildSidebarTabItems, type SidebarTabItem } from './sidebar-tab-model'
import { activateSidebarTab, closeSidebarTab, openSidebarTerminalTab } from './sidebar-tab-actions'

const EMPTY: never[] = []

// Why: the card row underneath activates the workspace and arms drag; tab clicks must not reach it.
function stopBubble(event: React.SyntheticEvent): void {
  event.stopPropagation()
}

function TabIcon({ item }: { item: SidebarTabItem }): React.JSX.Element {
  const kind = item.tab.contentType
  if (kind === 'browser' && item.faviconUrl) {
    return <img src={item.faviconUrl} alt="" className="size-3.5 shrink-0 rounded-sm" />
  }
  const Icon =
    kind === 'terminal'
      ? SquareTerminal
      : kind === 'browser'
        ? Globe
        : kind === 'simulator'
          ? Smartphone
          : kind === 'agent-session'
            ? Bot
            : FileText
  return <Icon className="size-3.5 shrink-0 text-muted-foreground" />
}

function CloseButton({ tab, label }: { tab: Tab; label: string }): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={translate(
        'auto.components.sidebar.SidebarWorkspaceTabs.close',
        'Close {{value0}}',
        {
          value0: label
        }
      )}
      className="ml-auto flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/sidebar-tab:opacity-100"
      onClick={(event) => {
        event.stopPropagation()
        closeSidebarTab(tab)
      }}
    >
      <X className="size-3" />
    </button>
  )
}

function SplitTabPill({ item }: { item: SidebarTabItem }): React.JSX.Element {
  return (
    <div
      className={cn(
        'group/sidebar-tab flex min-w-0 items-center gap-0.5 rounded-lg p-0.5',
        item.isActive ? 'bg-worktree-sidebar-accent' : 'bg-worktree-sidebar-accent/40'
      )}
    >
      {item.panes!.map((pane) => (
        <button
          key={pane.leafId}
          type="button"
          title={pane.title}
          className={cn(
            'flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-left text-[12px] transition-colors',
            pane.isActive
              ? 'bg-background/70 text-foreground shadow-sm'
              : 'text-muted-foreground hover:bg-background/40 hover:text-foreground'
          )}
          onClick={() => activateSidebarTab(item.tab, pane.leafId)}
        >
          <SquareTerminal className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">{pane.title}</span>
        </button>
      ))}
      <CloseButton tab={item.tab} label={item.title} />
    </div>
  )
}

function TabRow({ item }: { item: SidebarTabItem }): React.JSX.Element {
  return (
    <div
      role="button"
      tabIndex={0}
      title={item.title}
      className={cn(
        'group/sidebar-tab flex h-7 min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 text-[12px] transition-colors',
        item.isActive
          ? 'bg-worktree-sidebar-accent text-foreground'
          : 'text-muted-foreground hover:bg-worktree-sidebar-accent/50 hover:text-foreground'
      )}
      onClick={() => activateSidebarTab(item.tab)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          activateSidebarTab(item.tab)
        }
      }}
    >
      <TabIcon item={item} />
      <span className="min-w-0 truncate">{item.title}</span>
      {item.isDirty ? (
        <span className="ml-auto size-1.5 shrink-0 rounded-full bg-muted-foreground" />
      ) : (
        <CloseButton tab={item.tab} label={item.title} />
      )}
    </div>
  )
}

// Arc-style vertical tabs for one workspace: a split terminal tab is one pill of side-by-side panes.
export function SidebarWorkspaceTabs({ worktreeId }: { worktreeId: string }): React.JSX.Element {
  const unifiedTabs = useAppStore((s) => s.unifiedTabsByWorktree[worktreeId] ?? EMPTY)
  const groups = useAppStore((s) => s.groupsByWorktree[worktreeId] ?? EMPTY)
  const activeGroupId = useAppStore((s) => s.activeGroupIdByWorktree[worktreeId])
  const terminalTabs = useAppStore((s) => s.tabsByWorktree[worktreeId] ?? EMPTY)
  const terminalLayoutsByTabId = useAppStore((s) => s.terminalLayoutsByTabId)
  const runtimePaneTitlesByTabId = useAppStore((s) => s.runtimePaneTitlesByTabId)
  const openFiles = useAppStore((s) => s.openFiles)
  const browserWorkspaces = useAppStore((s) => s.browserTabsByWorktree[worktreeId] ?? EMPTY)
  const generatedTitlesEnabled = useAppStore((s) => s.settings?.tabAutoGenerateTitle === true)

  const items = useMemo(
    () =>
      buildSidebarTabItems({
        unifiedTabs,
        groups,
        activeGroupId,
        terminalTabs,
        terminalLayoutsByTabId,
        runtimePaneTitlesByTabId,
        openFiles,
        browserWorkspaces,
        generatedTitlesEnabled
      }),
    [
      unifiedTabs,
      groups,
      activeGroupId,
      terminalTabs,
      terminalLayoutsByTabId,
      runtimePaneTitlesByTabId,
      openFiles,
      browserWorkspaces,
      generatedTitlesEnabled
    ]
  )

  return (
    <div
      className="mt-1 flex select-none flex-col gap-0.5"
      data-sidebar-workspace-tabs=""
      onClick={stopBubble}
      onDoubleClick={stopBubble}
      onMouseDown={stopBubble}
      onPointerDown={stopBubble}
      onKeyDown={stopBubble}
    >
      <button
        type="button"
        className="flex h-7 items-center gap-2 rounded-md px-2 text-left text-[12px] text-muted-foreground transition-colors hover:bg-worktree-sidebar-accent/50 hover:text-foreground"
        onClick={() => openSidebarTerminalTab(worktreeId)}
      >
        <Plus className="size-3.5 shrink-0" />
        {translate('auto.components.sidebar.SidebarWorkspaceTabs.newTab', 'New Tab')}
      </button>
      {items.map((item) =>
        item.panes ? (
          <SplitTabPill key={item.tab.id} item={item} />
        ) : (
          <TabRow key={item.tab.id} item={item} />
        )
      )}
    </div>
  )
}
