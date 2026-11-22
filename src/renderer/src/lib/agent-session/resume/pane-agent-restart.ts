import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import { parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import {
  isResumableTuiAgent,
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata,
  type SleepingAgentLaunchConfig
} from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { isTuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent-config'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import { getAiVaultAgentProviderSession } from '../../../../../shared/ai-vault/resume/ai-vault-resume-startup'
import { isAiVaultAgent } from '../../../../../shared/ai-vault/contracts/ai-vault-types'
import { isSessionHeldByAnotherPane } from '../identity/claude-session-pane-holders'
import { pickPaneAgentRestartSession } from '../../../../../shared/native-chat/agent-presence/pane-agent-restart-session'
import {
  buildPaneAgentFreshStartup,
  buildPaneAgentResumeStartup,
  type PaneAgentRestartStartup
} from '../accounts/agent-account-restart-startup'
import type {
  PaneAgentRestartRefusal,
  PaneAgentRestartRequest,
  PaneAgentRestartResult
} from '../../../../../shared/native-chat/agent-presence/pane-agent-restart-contract'

type PaneAgentRestartSource = {
  agent: TuiAgent
  providerSession: AgentProviderSessionMetadata | null
  launchConfig?: SleepingAgentLaunchConfig
}

/** Restarts one of a tab's panes in place; false when that pane is not mounted here. */
type PaneAgentRestartExecutor = (leafId: string, startup: PaneAgentRestartStartup) => boolean

const executors = new Map<string, PaneAgentRestartExecutor>()
// Why: an exit can drop the pane's status row, which held the session and launch recipe.
const lastRunningByPaneKey = new Map<string, PaneAgentRestartSource>()
const REMEMBERED_PANES_MAX = 256

export function registerPaneAgentRestartExecutor(
  tabId: string,
  run: PaneAgentRestartExecutor
): () => void {
  executors.set(tabId, run)
  return () => {
    if (executors.get(tabId) === run) {
      executors.delete(tabId)
    }
  }
}

/** Keeps what each pane's agent was last running with, so a restart after its exit can reuse it. */
export function rememberRunningPaneAgents(
  state: AppState,
  previous: AppState['agentStatusByPaneKey']
): void {
  for (const [paneKey, entry] of state.agentStatusByPaneKey) {
    if (previous.get(paneKey) === entry) {
      continue
    }
    const providerSession = normalizeAgentProviderSession(entry.providerSession)
    if (!providerSession || !isTuiAgent(entry.agentType)) {
      continue
    }
    lastRunningByPaneKey.delete(paneKey)
    lastRunningByPaneKey.set(paneKey, {
      agent: entry.agentType,
      providerSession,
      launchConfig: state.getAgentLaunchConfigForStatusEntry(entry)
    })
  }
  for (const paneKey of lastRunningByPaneKey.keys()) {
    if (lastRunningByPaneKey.size <= REMEMBERED_PANES_MAX) {
      break
    }
    lastRunningByPaneKey.delete(paneKey)
  }
}

function resolveRestartSource(
  state: AppState,
  request: PaneAgentRestartRequest
): PaneAgentRestartSource | null {
  const entry = state.agentStatusByPaneKey.get(request.paneKey)
  const sleeping = state.sleepingAgentSessionsByPaneKey[request.paneKey]
  const remembered = lastRunningByPaneKey.get(request.paneKey)
  const agent = entry?.agentType ?? sleeping?.agent ?? remembered?.agent ?? request.agent
  if (!isTuiAgent(agent)) {
    return null
  }
  const named =
    request.sessionId && isAiVaultAgent(agent)
      ? getAiVaultAgentProviderSession({
          agent,
          sessionId: request.sessionId,
          ...(request.transcriptPath ? { filePath: request.transcriptPath } : {})
        })
      : null
  const providerSession = pickPaneAgentRestartSession(
    [
      normalizeAgentProviderSession(entry?.agentType === agent ? entry.providerSession : null),
      normalizeAgentProviderSession(sleeping?.agent === agent ? sleeping.providerSession : null),
      remembered?.agent === agent ? remembered.providerSession : null
    ],
    request.sessionId,
    named
  )
  const launchConfig =
    entry?.agentType === agent
      ? state.getAgentLaunchConfigForStatusEntry(entry)
      : sleeping?.agent === agent
        ? sleeping.launchConfig
        : remembered?.agent === agent
          ? remembered.launchConfig
          : undefined
  return { agent, providerSession, ...(launchConfig ? { launchConfig } : {}) }
}

/** Whether "Resume session" can name a conversation for this pane's agent. */
export function canResumePaneAgent(request: Omit<PaneAgentRestartRequest, 'mode'>): boolean {
  const source = resolveRestartSource(useAppStore.getState(), { ...request, mode: 'resume' })
  return Boolean(source?.providerSession && isResumableTuiAgent(source.agent))
}

/** Restarts the pane's agent in its own pane, as an account switch does: resumed or fresh. */
export function restartPaneAgent(request: PaneAgentRestartRequest): PaneAgentRestartResult {
  const refuse = (reason: PaneAgentRestartRefusal): PaneAgentRestartResult => ({
    ok: false,
    reason
  })
  const pane = parsePaneKey(request.paneKey)
  const run = pane ? executors.get(pane.tabId) : undefined
  const state = useAppStore.getState()
  const tabEntry = pane
    ? Object.entries(state.tabsByWorktree)
        .map(([worktreeId, tabs]) => ({ worktreeId, tab: tabs.find((t) => t.id === pane.tabId) }))
        .find((candidate) => candidate.tab)
    : undefined
  if (!pane || !run || !tabEntry?.tab) {
    return refuse('pane_unavailable')
  }
  const source = resolveRestartSource(state, request)
  if (!source) {
    return refuse('no_launch_command')
  }
  const target = {
    tabId: pane.tabId,
    leafId: pane.leafId,
    worktreeId: tabEntry.worktreeId,
    shellOverride: tabEntry.tab.shellOverride
  }
  let startup: PaneAgentRestartStartup | null
  try {
    if (request.mode === 'fresh') {
      startup = buildPaneAgentFreshStartup(source.agent, target, source.launchConfig)
    } else {
      const { providerSession, agent } = source
      if (!providerSession || !isResumableTuiAgent(agent)) {
        return refuse('no_resume')
      }
      if (isSessionHeldByAnotherPane(state, request.paneKey, providerSession.id)) {
        return refuse('held_elsewhere')
      }
      startup = buildPaneAgentResumeStartup(
        { agent, providerSession, launchConfig: source.launchConfig },
        target
      )
    }
  } catch {
    return refuse('no_launch_command')
  }
  if (!startup) {
    return refuse(request.mode === 'resume' ? 'no_resume' : 'no_launch_command')
  }
  try {
    return run(pane.leafId, startup) ? { ok: true } : refuse('pane_unavailable')
  } catch {
    return refuse('failed')
  }
}
