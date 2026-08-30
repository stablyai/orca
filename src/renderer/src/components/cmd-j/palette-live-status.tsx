import React, { createContext, useContext, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { AgentStateDot } from '@/components/AgentStateDot'
import { StateIndicatorTooltip } from '@/components/StateIndicatorTooltip'
import StatusIndicator from '@/components/sidebar/StatusIndicator'
import { FilledBellIcon } from '@/components/sidebar/WorktreeCardHelpers'
import {
  buildExplicitEntriesByTabId,
  type TabPaneInputSources
} from '@/components/sidebar/smart-attention'
import { cn } from '@/lib/utils'
import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import { getLiveAgentStatusByWorktreeId } from '@/lib/worktree-activity-state'
import {
  getWorktreeStatus,
  getWorktreeStatusLabel,
  type WorktreeStatus
} from '@/lib/worktree-status'
import {
  resolveRecentWorkspaceTabStatus,
  type RecentWorkspaceTabRow
} from '@/lib/recent-workspace-tab-rows'
import {
  resolveTerminalTabAttentionBadge,
  terminalTabHasUnreadActivity,
  type TerminalTabAttentionBadge
} from '@/components/tab-bar/terminal-tab-activity-status'
import { translate } from '@/i18n/i18n'
import type { LiveAgentWorktreeStatus } from '@/lib/worktree-activity-state'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { BrowserWorkspace } from '../../../../shared/browser-workspace-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { useNow } from '@/hooks/use-now'

/** Confines the app's hottest status subscriptions here so only the dots re-render on their churn. */
type PaletteLiveStatus = {
  liveAgentStatusByWorktreeId: ReadonlyMap<string, LiveAgentWorktreeStatus>
  agentStatusPaneIdsByTabId: Record<string, ReadonlySet<string>>
  paneSources: TabPaneInputSources
  tabsByWorktree: Record<string, TerminalTab[]>
  browserTabsByWorktree: Record<string, BrowserWorkspace[]>
  unreadTerminalTabs: Record<string, true>
  unreadAgentCompletionPanes: Record<string, true>
  /** Bumped with the maps so consumers re-resolve `now`-sensitive freshness on the same tick. */
  statusEpoch: number
  now: number
}

const PaletteLiveStatusContext = createContext<PaletteLiveStatus | null>(null)

export function PaletteLiveStatusProvider({
  active,
  children
}: {
  /** Open, or still animating closed — matches the palette's own status-input gate. */
  active: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const now = useNow(30_000, active)
  const {
    agentStatusByPaneKey,
    runtimePaneTitlesByTabId,
    ptyIdsByTabId,
    terminalLayoutsByTabId,
    tabsByWorktree,
    browserTabsByWorktree,
    migrationUnsupportedByPtyId,
    unreadTerminalTabs,
    unreadAgentCompletionPanes
  } = useAppStore(
    useShallow((s) =>
      active
        ? {
            agentStatusByPaneKey: s.agentStatusByPaneKey,
            runtimePaneTitlesByTabId: s.runtimePaneTitlesByTabId,
            ptyIdsByTabId: s.ptyIdsByTabId,
            terminalLayoutsByTabId: s.terminalLayoutsByTabId,
            tabsByWorktree: s.tabsByWorktree,
            browserTabsByWorktree: s.browserTabsByWorktree,
            migrationUnsupportedByPtyId: s.migrationUnsupportedByPtyId,
            unreadTerminalTabs: s.unreadTerminalTabs,
            unreadAgentCompletionPanes: s.unreadAgentCompletionPanes
          }
        : EMPTY_LIVE_INPUTS
    )
  )
  const statusEpoch = useAppStore((s) => (active ? s.agentStatusEpoch : 0))

  const value = useMemo<PaletteLiveStatus>(() => {
    // Why: `now` decides freshness, so both derivations must read it on the same tick — otherwise a
    // "done" dot can outlive its window while the worktree row beside it has already decayed.
    const entriesByTabId = buildExplicitEntriesByTabId(
      agentStatusByPaneKey,
      migrationUnsupportedByPtyId
    )
    return {
      liveAgentStatusByWorktreeId: getLiveAgentStatusByWorktreeId(
        agentStatusByPaneKey,
        tabsByWorktree,
        now
      ),
      agentStatusPaneIdsByTabId: buildLiveAgentStatusPaneIdsByTabId(entriesByTabId, now),
      paneSources: {
        entriesByTabId,
        ptyIdsByTabId,
        runtimePaneTitlesByTabId,
        terminalLayoutsByTabId
      },
      tabsByWorktree,
      browserTabsByWorktree,
      unreadTerminalTabs,
      unreadAgentCompletionPanes,
      statusEpoch,
      now
    }
  }, [
    agentStatusByPaneKey,
    browserTabsByWorktree,
    migrationUnsupportedByPtyId,
    ptyIdsByTabId,
    runtimePaneTitlesByTabId,
    statusEpoch,
    tabsByWorktree,
    terminalLayoutsByTabId,
    unreadAgentCompletionPanes,
    unreadTerminalTabs,
    now
  ])

  return (
    <PaletteLiveStatusContext.Provider value={value}>{children}</PaletteLiveStatusContext.Provider>
  )
}

function buildLiveAgentStatusPaneIdsByTabId(
  entriesByTabId: ReadonlyMap<string, readonly AgentStatusEntry[]>,
  now: number
): Record<string, ReadonlySet<string>> {
  const paneIdsByTabId: Record<string, ReadonlySet<string>> = {}
  for (const [tabId, entries] of entriesByTabId) {
    const paneIds = new Set<string>()
    for (const entry of entries) {
      if (
        entry.restoredUnconfirmed !== true &&
        !isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)
      ) {
        continue
      }
      const paneId = parsePaneKey(entry.paneKey)?.leafId
      if (paneId) {
        paneIds.add(paneId)
      }
    }
    if (paneIds.size > 0) {
      paneIdsByTabId[tabId] = paneIds
    }
  }
  return paneIdsByTabId
}

const EMPTY_LIVE_INPUTS = Object.freeze({
  agentStatusByPaneKey: {},
  runtimePaneTitlesByTabId: {},
  ptyIdsByTabId: {},
  terminalLayoutsByTabId: {},
  tabsByWorktree: {},
  browserTabsByWorktree: {},
  migrationUnsupportedByPtyId: {},
  unreadTerminalTabs: {},
  unreadAgentCompletionPanes: {}
})

function useLiveStatus(): PaletteLiveStatus | null {
  return useContext(PaletteLiveStatusContext)
}

/**
 * Live dot for a worktree row. Rendering it instead of resolving the status in the palette body is
 * what keeps an agent transition from re-rendering every row in the list.
 */
export function PaletteWorktreeStatusDot({
  worktree
}: {
  worktree: Pick<Worktree, 'id'>
}): React.JSX.Element | null {
  const live = useLiveStatus()
  if (!live) {
    return null
  }
  const status = getWorktreeStatus(
    live.tabsByWorktree[worktree.id] ?? [],
    live.browserTabsByWorktree[worktree.id] ?? [],
    live.paneSources.ptyIdsByTabId,
    live.paneSources.runtimePaneTitlesByTabId,
    {
      liveAgentStatus: live.liveAgentStatusByWorktreeId.get(worktree.id),
      agentStatusPaneIdsByTabId: live.agentStatusPaneIdsByTabId
    }
  )
  return (
    <>
      <StatusIndicator status={status} aria-hidden="true" />
      <span className="sr-only">{getWorktreeStatusLabel(status)}</span>
    </>
  )
}

/**
 * Leading slot for a recent chat/terminal row: content icon + shared attention badge
 * (resolveTerminalTabAttentionBadge — same ladder as the tab strip).
 */
export function PaletteRecentTabStatusDot({
  row,
  fallback
}: {
  row: RecentWorkspaceTabRow | null
  fallback: React.ReactNode
}): React.JSX.Element {
  const live = useLiveStatus()
  const terminalTabId = row?.terminalTab?.id
  const status: WorktreeStatus | null =
    live && row?.terminalTab
      ? resolveRecentWorkspaceTabStatus(row, live.paneSources, live.now)
      : null
  const hasUnread =
    live != null &&
    terminalTabId != null &&
    terminalTabHasUnreadActivity({
      terminalTabId,
      unreadTerminalTabs: live.unreadTerminalTabs,
      unreadAgentCompletionPanes: live.unreadAgentCompletionPanes
    })
  const badge = resolveTerminalTabAttentionBadge({ status, hasUnread })
  if (badge == null) {
    return <>{fallback}</>
  }
  const statusLabel =
    badge === 'unread'
      ? // Why the tab-bar key: same bell, same sentence — a fresh key here would ship untranslated
        // in every non-English locale for the sake of a namespace.
        translate(
          'auto.components.tab.bar.TerminalTabLeadingIcon.7ab2964bea',
          'Unread agent completion'
        )
      : getWorktreeStatusLabel(badge)
  // Why: the outer hit target owns the tooltip because the overlaid pip ignores pointer events.
  return (
    <StateIndicatorTooltip label={statusLabel}>
      <span className="relative inline-flex size-3.5 shrink-0 items-center justify-center">
        {fallback}
        <span
          className={cn(
            // Why popover, not background: the dialog surface is --popover (#171717 in dark), while
            // --background is the app canvas (#0a0a0a) — using it punched a dark halo through every
            // dark-mode row. Selected rows use --jump-palette-selection-surface so the cutout tracks
            // the stronger keyboard highlight from main.css.
            'pointer-events-none absolute -right-0.5 -bottom-0.5 flex items-center justify-center rounded-full',
            'bg-popover ring-2 ring-popover',
            'group-data-[selected=true]:bg-[var(--jump-palette-selection-surface)] group-data-[selected=true]:ring-[var(--jump-palette-selection-surface)]'
          )}
          aria-hidden="true"
        >
          <RecentTabAttentionBadgeGlyph badge={badge} />
        </span>
        <span className="sr-only">{statusLabel}</span>
      </span>
    </StateIndicatorTooltip>
  )
}

/** Renders the shared attention glyph — AgentStateDot for agent states, bell for unread. */
function RecentTabAttentionBadgeGlyph({
  badge
}: {
  badge: TerminalTabAttentionBadge
}): React.JSX.Element {
  if (badge === 'unread') {
    return <FilledBellIcon className="size-2.5 text-amber-500 drop-shadow-sm" />
  }
  // Why: AgentStateDot owns working/permission/done glyphs app-wide (spinner / ? / check).
  return <AgentStateDot state={badge} size="sm" title={null} />
}
