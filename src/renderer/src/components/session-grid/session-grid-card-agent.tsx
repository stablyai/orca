import React, { useMemo } from 'react'
import { useAppStore } from '@/store'
import { useTabAgent } from '@/lib/use-tab-agent'
import { AgentIcon } from '@/lib/agent-catalog'
import { ShellIcon } from '@/components/tab-bar/shell-icons'
import { cn } from '@/lib/utils'
import type { SessionGridItem } from '../../../../shared/session-grid-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { TuiAgent } from '../../../../shared/tui-agent'

/** The tab bar's agent identity for a card, resolved from the store tab behind `item.tabId`. */
export function useSessionGridCardAgent(item: SessionGridItem): TuiAgent | null {
  const storeTab = useAppStore(
    (s) => s.tabsByWorktree[item.worktreeId]?.find((tab) => tab.id === item.tabId) ?? null
  )
  // Why: hooks cannot be skipped, so a card whose tab is mid-close resolves against what the item still knows.
  const tab = useMemo<TerminalTab>(
    () =>
      storeTab ?? {
        id: item.tabId,
        ptyId: item.ptyId,
        worktreeId: item.worktreeId,
        title: item.title,
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: item.createdAt,
        shellOverride: item.shellOverride,
        launchAgent: item.launchAgent
      },
    [storeTab, item]
  )
  return useTabAgent(tab)
}

/** Provider glyph when an agent owns the pane, the shell's tile otherwise — the tab bar's identity treatment. */
export function SessionGridCardIdentityIcon({
  agent,
  shell,
  className
}: {
  agent: TuiAgent | null
  shell: TerminalTab['shellOverride']
  className?: string
}): React.JSX.Element {
  return (
    <span
      className={cn('inline-flex shrink-0', className)}
      data-agent-icon={agent ?? undefined}
      data-shell-icon={agent ? undefined : (shell ?? 'generic')}
      aria-hidden
    >
      {agent ? <AgentIcon agent={agent} size={14} /> : <ShellIcon shell={shell} size={14} />}
    </span>
  )
}
