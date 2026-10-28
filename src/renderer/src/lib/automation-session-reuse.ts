import type { AutomationRun } from '../../../shared/automations-types'
import {
  findLiveAutomationRun,
  findReusableAutomationRun,
  isAutomationReuseAgent,
  isIdleAutomationReuseStatus,
  type ReusableAutomationRun
} from '../../../shared/automation-session-reuse'
import type { TuiAgent } from '../../../shared/tui-agent'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'

export type ReusableAutomationSession = {
  tabId: string
  ptyId: string
  paneKey: string
}

export type AutomationSessionLookup = {
  automationId: string
  agentId: TuiAgent
  worktreeId: string
  currentRunId: string
  runs: AutomationRun[]
  state: Pick<
    AppState,
    'agentStatusByPaneKey' | 'ptyIdsByTabId' | 'terminalLayoutsByTabId' | 'unifiedTabsByWorktree'
  >
}

export function findReusableAutomationSession(
  args: AutomationSessionLookup
): ReusableAutomationSession | null {
  return findReusableAutomationRun(sessionLookup(args))
}

/** The newest session this automation still holds, even while its agent is busy. */
export function findLiveAutomationSession(
  args: AutomationSessionLookup
): ReusableAutomationSession | null {
  return findLiveAutomationRun(sessionLookup(args))?.session ?? null
}

function sessionLookup(args: AutomationSessionLookup) {
  const { state, ...selection } = args
  const terminalTabIds = new Set(
    (state.unifiedTabsByWorktree[args.worktreeId] ?? [])
      .filter((tab) => tab.contentType === 'terminal')
      .map((tab) => tab.entityId)
  )
  return {
    ...selection,
    agentStatusForPane: (paneKey: string) => state.agentStatusByPaneKey[paneKey],
    liveSession: (run: ReusableAutomationRun): ReusableAutomationSession | null => {
      const parsed = parsePaneKey(run.terminalPaneKey)
      if (
        !parsed ||
        !terminalTabIds.has(parsed.tabId) ||
        !isRunPtyLiveInPane(state, parsed.tabId, parsed.leafId, run.terminalPtyId)
      ) {
        return null
      }
      return { tabId: parsed.tabId, ptyId: run.terminalPtyId, paneKey: run.terminalPaneKey }
    }
  }
}

/** A pane keeps the run's session only while it still holds the run's own PTY. */
export function isRunPtyLiveInPane(
  state: Pick<AppState, 'ptyIdsByTabId' | 'terminalLayoutsByTabId'>,
  tabId: string,
  leafId: string,
  ptyId: string
): boolean {
  if (!state.ptyIdsByTabId[tabId]?.includes(ptyId)) {
    return false
  }
  const layoutPtyId = state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId]
  return layoutPtyId === undefined || layoutPtyId === ptyId
}

type SessionAvailability = 'idle' | 'busy' | 'gone'

/** Give up waiting after a long turn so the run still reaches a terminal outcome. */
const AUTOMATION_IDLE_WAIT_TIMEOUT_MS = 60 * 60 * 1000

/**
 * Resolves the reused session once its agent finishes the current turn.
 * A closed pane, a lost status row, another agent in the pane, or a turn still running past the
 * timeout resolves null so the caller launches fresh.
 */
export function waitForIdleAutomationSession(args: {
  session: ReusableAutomationSession
  agentId: TuiAgent
}): Promise<ReusableAutomationSession | null> {
  const { session, agentId } = args
  const parsed = parsePaneKey(session.paneKey)
  if (!parsed) {
    return Promise.resolve(null)
  }
  const availability = (): SessionAvailability => {
    const state = useAppStore.getState()
    if (!isRunPtyLiveInPane(state, parsed.tabId, parsed.leafId, session.ptyId)) {
      return 'gone'
    }
    const status = state.agentStatusByPaneKey[session.paneKey]
    if (!status || !isAutomationReuseAgent(status, agentId)) {
      return 'gone'
    }
    if (status.state === 'done') {
      // Why: a session boundary is a connection, not a turn, so there is no busy turn to wait out.
      return isIdleAutomationReuseStatus(status, agentId) ? 'idle' : 'gone'
    }
    return 'busy'
  }
  const initial = availability()
  if (initial !== 'busy') {
    return Promise.resolve(initial === 'idle' ? session : null)
  }
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = useAppStore.subscribe(() => {
      const next = availability()
      if (next === 'busy') {
        return
      }
      clearTimeout(timer)
      unsubscribe()
      resolve(next === 'idle' ? session : null)
    })
    timer = setTimeout(() => {
      unsubscribe()
      resolve(null)
    }, AUTOMATION_IDLE_WAIT_TIMEOUT_MS)
  })
}
