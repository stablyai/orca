import React, { createContext, useContext, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import StatusIndicator from '@/components/sidebar/StatusIndicator'
import {
  buildExplicitEntriesByTabId,
  type TabPaneInputSources
} from '@/components/sidebar/smart-attention'
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
import type { LiveAgentWorktreeStatus } from '@/lib/worktree-activity-state'
import type { BrowserWorkspace, TerminalTab, Worktree } from '../../../../shared/types'

/** Confines the app's hottest status subscriptions here so only the dots re-render on their churn. */
type PaletteLiveStatus = {
  liveAgentStatusByWorktreeId: ReadonlyMap<string, LiveAgentWorktreeStatus>
  paneSources: TabPaneInputSources
  tabsByWorktree: Record<string, TerminalTab[]>
  browserTabsByWorktree: Record<string, BrowserWorkspace[]>
  /** Bumped with the maps so consumers re-resolve `now`-sensitive freshness on the same tick. */
  statusEpoch: number
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
  const {
    agentStatusByPaneKey,
    runtimePaneTitlesByTabId,
    ptyIdsByTabId,
    terminalLayoutsByTabId,
    tabsByWorktree,
    browserTabsByWorktree,
    migrationUnsupportedByPtyId
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
            migrationUnsupportedByPtyId: s.migrationUnsupportedByPtyId
          }
        : EMPTY_LIVE_INPUTS
    )
  )
  const statusEpoch = useAppStore((s) => (active ? s.agentStatusEpoch : 0))

  const value = useMemo<PaletteLiveStatus>(() => {
    // Why: `now` decides freshness, so both derivations must read it on the same tick — otherwise a
    // "done" dot can outlive its window while the worktree row beside it has already decayed.
    const now = Date.now()
    return {
      liveAgentStatusByWorktreeId: getLiveAgentStatusByWorktreeId(
        agentStatusByPaneKey,
        tabsByWorktree,
        now
      ),
      paneSources: {
        entriesByTabId: buildExplicitEntriesByTabId(
          agentStatusByPaneKey,
          migrationUnsupportedByPtyId
        ),
        ptyIdsByTabId,
        runtimePaneTitlesByTabId,
        terminalLayoutsByTabId
      },
      tabsByWorktree,
      browserTabsByWorktree,
      statusEpoch
    }
  }, [
    agentStatusByPaneKey,
    browserTabsByWorktree,
    migrationUnsupportedByPtyId,
    ptyIdsByTabId,
    runtimePaneTitlesByTabId,
    statusEpoch,
    tabsByWorktree,
    terminalLayoutsByTabId
  ])

  return (
    <PaletteLiveStatusContext.Provider value={value}>{children}</PaletteLiveStatusContext.Provider>
  )
}

const EMPTY_LIVE_INPUTS = Object.freeze({
  agentStatusByPaneKey: {},
  runtimePaneTitlesByTabId: {},
  ptyIdsByTabId: {},
  terminalLayoutsByTabId: {},
  tabsByWorktree: {},
  browserTabsByWorktree: {},
  migrationUnsupportedByPtyId: {}
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
    { liveAgentStatus: live.liveAgentStatusByWorktreeId.get(worktree.id) }
  )
  return (
    <>
      <StatusIndicator status={status} aria-hidden="true" />
      <span className="sr-only">{getWorktreeStatusLabel(status)}</span>
    </>
  )
}

/**
 * Live dot for a recent chat/terminal row, falling back to the row's content icon when the row has
 * no agent-bearing terminal behind it.
 */
export function PaletteRecentTabStatusDot({
  row,
  fallback
}: {
  row: RecentWorkspaceTabRow | null
  fallback: React.ReactNode
}): React.JSX.Element {
  const live = useLiveStatus()
  const status: WorktreeStatus | null =
    live && row?.terminalTab
      ? resolveRecentWorkspaceTabStatus(row, live.paneSources, Date.now())
      : null
  if (!status) {
    return <>{fallback}</>
  }
  return (
    <>
      <StatusIndicator status={status} aria-hidden="true" />
      <span className="sr-only">{getWorktreeStatusLabel(status)}</span>
    </>
  )
}
