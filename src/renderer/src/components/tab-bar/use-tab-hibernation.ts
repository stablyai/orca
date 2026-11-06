import { useMemo } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { getSleepingRecordTabId } from '@/lib/sleeping-agent-wake-requests'
import {
  isResumableTuiAgent,
  isPaneSleepRecord,
  type SleepingAgentSessionRecord
} from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import { getAgentResumeArgv } from '../../../../shared/agent-resume-argv'
import { noteArmsHibernatedPaneWake } from '@/components/terminal-pane/pty-connection/pty-exit-hibernate'
import {
  getEligiblePane,
  getEntryTabId,
  toRuntimePtyId,
  type EligiblePane
} from '@/lib/agent-hibernation-pane-eligibility'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { getAllDrivers } from '@/lib/pane-manager/mobile-driver-state'
import {
  WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT,
  type WakeHibernatedAgentsWorktreeDetail
} from '@/constants/terminal'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { getForegroundTerminalTabLastSeenAtById } from '@/lib/foreground-terminal-tabs'
import {
  getHibernationBoundaryResolvedAtByPaneKey,
  getHibernationPtyBindingFirstSeenAtByPaneKey
} from '@/lib/agent-hibernation-pane-age'

export type TabHibernationState = Pick<
  AppState,
  | 'tabsByWorktree'
  | 'terminalLayoutsByTabId'
  | 'ptyIdsByTabId'
  | 'agentStatusByPaneKey'
  | 'sleepingAgentSessionsByPaneKey'
  | 'lastTerminalInputAtByPaneKey'
> & {
  foregroundTerminalLastSeenAtByTabId?: Record<string, number | undefined>
  ptyBindingFirstSeenAtByPaneKey?: Record<string, number | undefined>
  boundaryResolvedAtByPaneKey?: Record<string, number | undefined>
}

export type SleepablePaneTarget = {
  paneKey: string
  tabId: string
  leafId: string
  ptyId: string
  expectedRuntimePtyId: string
}

export type SleepTerminalTabOptions = {
  worktreeId: string
  tabId: string
  isActive?: boolean
  groupId?: string
  onActivate?: (tabId: string) => void
}

export type UseTabHibernationArgs = {
  open?: boolean
  tabId: string
  worktreeId: string
  isActive?: boolean
  groupId?: string
  onActivate: (tabId: string) => void
}

/** Returns true when the tab has 0 live PTYs and at least one resumable sleeping session record. */
export function isTerminalTabSleeping(
  state: {
    ptyIdsByTabId?: Record<string, string[] | undefined>
    sleepingAgentSessionsByPaneKey?: Record<string, SleepingAgentSessionRecord | undefined>
  },
  tabId: string
): boolean {
  const livePtys = state.ptyIdsByTabId?.[tabId] ?? []
  if (livePtys.length > 0) {
    return false
  }
  const sleepingRecords = state.sleepingAgentSessionsByPaneKey ?? {}
  for (const record of Object.values(sleepingRecords)) {
    if (!record) {
      continue
    }
    if (getSleepingRecordTabId(record) !== tabId) {
      continue
    }
    if (
      record.agent &&
      isResumableTuiAgent(record.agent) &&
      Boolean(getAgentResumeArgv(record.agent, record.providerSession)) &&
      (noteArmsHibernatedPaneWake(record) || isPaneSleepRecord(record)) &&
      record.origin !== 'live'
    ) {
      return true
    }
  }
  return false
}

/** Returns panes in tabId eligible for immediate manual hibernation (idleMs: 0). */
export function getSleepablePanesForTerminalTab(
  state: TabHibernationState,
  worktreeId: string,
  tabId: string
): SleepablePaneTarget[] {
  const tab = (state.tabsByWorktree?.[worktreeId] ?? []).find((candidate) => candidate.id === tabId)
  if (!tab) {
    return []
  }
  const layout = state.terminalLayoutsByTabId?.[tabId]
  const liveTabPtyIds = (state.ptyIdsByTabId?.[tabId] ?? []).filter(
    (id): id is string => typeof id === 'string' && id.length > 0
  )
  if (liveTabPtyIds.length === 0) {
    return []
  }
  const livePtyIdsSet = new Set(liveTabPtyIds.map(toRuntimePtyId))
  const mobileLockedPtyIds = new Set(
    [...getAllDrivers()]
      .filter(([, driver]) => driver.kind === 'mobile')
      .map(([ptyId]) => toRuntimePtyId(ptyId))
  )

  const tabAgentEntries: AgentStatusEntry[] = []
  for (const entry of Object.values(state.agentStatusByPaneKey ?? {})) {
    if (!entry) {
      continue
    }
    if (getEntryTabId(entry) !== tabId) {
      continue
    }
    const parsed = parsePaneKey(entry.paneKey)
    if (!parsed || (entry.tabId && parsed.tabId !== entry.tabId)) {
      continue
    }
    const ptyId = layout?.ptyIdsByLeafId?.[parsed.leafId]
    if (ptyId && livePtyIdsSet.has(toRuntimePtyId(ptyId))) {
      tabAgentEntries.push(entry)
    }
  }

  // Why: hibernation is specifically for resumable agents; tabs without live agent panes cannot hibernate.
  if (tabAgentEntries.length === 0) {
    return []
  }

  const eligiblePanes: EligiblePane[] = []
  const now = Date.now()
  for (const entry of tabAgentEntries) {
    const eligible = getEligiblePane({
      entry,
      tab,
      layout,
      livePtyIds: livePtyIdsSet,
      sleepingAgentSessionsByPaneKey: state.sleepingAgentSessionsByPaneKey ?? {},
      lastTerminalInputAtByPaneKey: state.lastTerminalInputAtByPaneKey ?? {},
      foregroundTerminalLastSeenAtByTabId:
        state.foregroundTerminalLastSeenAtByTabId ?? getForegroundTerminalTabLastSeenAtById(),
      ptyBindingFirstSeenAtByPaneKey:
        state.ptyBindingFirstSeenAtByPaneKey ?? getHibernationPtyBindingFirstSeenAtByPaneKey(),
      boundaryResolvedAtByPaneKey:
        state.boundaryResolvedAtByPaneKey ?? getHibernationBoundaryResolvedAtByPaneKey(),
      mobileLockedPtyIds,
      now,
      idleMs: 0
    })
    // Ensure all live agent panes in the tab are eligible before allowing tab sleep.
    if (!eligible) {
      return []
    }
    eligiblePanes.push(eligible)
  }

  // Ensure no non-agent panes in the tab are left running behind.
  if (eligiblePanes.length !== liveTabPtyIds.length) {
    return []
  }

  return eligiblePanes.map((eligible) => ({
    paneKey: eligible.paneKey,
    tabId: eligible.tabId,
    leafId: eligible.leafId,
    ptyId: eligible.ptyId,
    expectedRuntimePtyId: eligible.runtimePtyId
  }))
}

/** Shuts down eligible agent panes in tabId for manual hibernation, switching to a sibling tab if active. */
export async function sleepTerminalTab(
  worktreeIdOrOpts: string | SleepTerminalTabOptions,
  maybeTabId?: string,
  maybeOnActivate?: (tabId: string) => void
): Promise<void> {
  const opts: SleepTerminalTabOptions =
    typeof worktreeIdOrOpts === 'string'
      ? { worktreeId: worktreeIdOrOpts, tabId: maybeTabId!, onActivate: maybeOnActivate }
      : worktreeIdOrOpts
  const { worktreeId, tabId, onActivate, isActive } = opts
  const state = useAppStore.getState()
  const targets = getSleepablePanesForTerminalTab(state, worktreeId, tabId)
  if (targets.length === 0) {
    return
  }

  const isTabActive =
    isActive ?? (state.activeTabId === tabId && state.activeWorktreeId === worktreeId)
  if (isTabActive) {
    // If the tab being put to sleep is currently active and there is a sibling tab in the worktree, activate it first so the sleeping tab becomes hidden.
    const siblingTab = (state.tabsByWorktree?.[worktreeId] ?? []).find(
      (candidate) => candidate.id !== tabId
    )
    const siblingUnified = (state.unifiedTabsByWorktree?.[worktreeId] ?? []).find(
      (candidate) => candidate.id !== tabId
    )
    const sibling = siblingTab ?? siblingUnified
    if (sibling) {
      if (onActivate) {
        onActivate(sibling.id)
      } else {
        state.setActiveTab(sibling.id)
      }
    }
  }

  for (const target of targets) {
    await state.shutdownCompletedAgentPaneForHibernation(worktreeId, {
      ...target,
      restoreOnTabOpenOnly: true
    })
  }
}

/** Activates the tab and dispatches worktree-wide wake so mounted panes resume immediately. */
export function wakeTerminalTab(
  worktreeId: string,
  tabId: string,
  onActivate?: (tabId: string) => void
): void {
  onActivate?.(tabId)
  const wokenClaimKeys = new Set<string>()
  window.dispatchEvent(
    new CustomEvent<WakeHibernatedAgentsWorktreeDetail>(WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT, {
      detail: { worktreeId, wokenClaimKeys }
    })
  )
}

/** Hook providing sleep state and manual Sleep Tab / Wake Tab handlers for tab menus. */
export function useTabHibernation(args: UseTabHibernationArgs): {
  isSleeping: boolean
  canSleepTab: boolean
  onSleepTab?: () => void
  onWakeTab?: () => void
} {
  const { open = true, tabId, worktreeId, isActive = false, groupId, onActivate } = args
  const isSleeping = useAppStore((s) => isTerminalTabSleeping(s, tabId))

  const sleepablePanes = useMemo(() => {
    if (!open || isSleeping) {
      return []
    }
    return getSleepablePanesForTerminalTab(useAppStore.getState(), worktreeId, tabId)
  }, [open, isSleeping, worktreeId, tabId])

  const onSleepTab =
    !isSleeping && sleepablePanes.length > 0
      ? () => {
          void sleepTerminalTab({
            worktreeId,
            tabId,
            isActive,
            groupId,
            onActivate
          })
        }
      : undefined

  const onWakeTab = isSleeping
    ? () => {
        wakeTerminalTab(worktreeId, tabId, onActivate)
      }
    : undefined

  return {
    isSleeping,
    canSleepTab: sleepablePanes.length > 0,
    onSleepTab,
    onWakeTab
  }
}
