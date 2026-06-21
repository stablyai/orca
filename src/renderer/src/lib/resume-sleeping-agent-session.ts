import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { buildAgentResumeStartupPlan } from '@/lib/tui-agent-startup'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import { reconcileTabOrder } from '@/components/tab-bar/reconcile-order'
import { isWslUncPath } from '../../../shared/wsl-paths'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { collectSleepingAgentSessionRecordsForWorktree } from '@/store/slices/agent-status'
import { translate } from '@/i18n/i18n'

function getResumeLaunchPlatform(worktreeId: string): NodeJS.Platform {
  const state = useAppStore.getState()
  const worktree = state.getKnownWorktreeById(worktreeId)
  const repo = worktree ? state.repos.find((entry) => entry.id === worktree.repoId) : null
  const projectRuntime = getLocalProjectExecutionRuntimeContext(state, worktreeId)
  if (projectRuntime?.status === 'repair-required') {
    return projectRuntime.repair.preferredRuntime.kind === 'wsl' ? 'linux' : CLIENT_PLATFORM
  }
  if (projectRuntime?.status === 'resolved' && projectRuntime.runtime.kind === 'wsl') {
    return 'linux'
  }
  if (repo?.connectionId || (worktree?.path && isWslUncPath(worktree.path))) {
    return 'linux'
  }
  return CLIENT_PLATFORM
}

function appendTabToWorktreeOrder(worktreeId: string, tabId: string): void {
  const state = useAppStore.getState()
  const termIds = (state.tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id)
  const editorIds = state.openFiles
    .filter((file) => file.worktreeId === worktreeId)
    .map((f) => f.id)
  const browserIds = (state.browserTabsByWorktree?.[worktreeId] ?? []).map((tab) => tab.id)
  const base = reconcileTabOrder(
    state.tabBarOrderByWorktree[worktreeId],
    termIds,
    editorIds,
    browserIds
  )
  const order = base.filter((id) => id !== tabId)
  order.push(tabId)
  state.setTabBarOrder(worktreeId, order)
}

function launchSleepingAgentSession(record: SleepingAgentSessionRecord): boolean {
  const state = useAppStore.getState()
  const startupPlan = buildAgentResumeStartupPlan({
    agent: record.agent,
    providerSession: record.providerSession,
    cmdOverrides: state.settings?.agentCmdOverrides ?? {},
    agentArgs: resolveTuiAgentLaunchArgs(record.agent, state.settings?.agentDefaultArgs),
    agentEnv: resolveTuiAgentLaunchEnv(record.agent, state.settings?.agentDefaultEnv),
    platform: getResumeLaunchPlatform(record.worktreeId)
  })
  if (!startupPlan) {
    toast.error(
      translate(
        'auto.lib.resume.sleeping.agent.session.f235f604fd',
        'This agent session cannot be resumed.'
      )
    )
    return false
  }

  const tab = state.createTab(record.worktreeId, undefined, undefined, {
    launchAgent: record.agent
  })
  state.queueTabStartupCommand(tab.id, {
    command: startupPlan.launchCommand,
    ...(startupPlan.startupCommandDelivery
      ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
      : {}),
    showSessionRestoredBanner: true,
    telemetry: {
      agent_kind: tuiAgentToAgentKind(record.agent),
      launch_source: 'sidebar',
      request_kind: 'resume'
    }
  })
  state.clearSleepingAgentSession(record.paneKey)
  state.setActiveTabType('terminal')
  appendTabToWorktreeOrder(record.worktreeId, tab.id)
  return true
}

/**
 * Resume a single RETAINED ("done") agent row by its paneKey, restoring the
 * past Claude/Hermes session instead of leaving the row inert.
 *
 * Why (GOAL 2, blank-terminal fix): a retained agent's tab/PTY is gone, so the
 * sidebar's handleActivateRetainedAgent was an intentional no-op — clicking it
 * did nothing (and a stale tab activation would render a blank terminal). But
 * orca already captures a resumable session id for done agents: a retained
 * entry whose agentType is resumable and that carries a providerSession can be
 * converted into a SleepingAgentSessionRecord and relaunched through the SAME
 * proven path worktree activation uses (buildAgentResumeStartupPlan ->
 * `<agent> --resume <id>`), which makes the CLI replay/continue the prior
 * session in a fresh terminal tab. This reuses collectSleepingAgentSessionRecordsForWorktree
 * (no origin -> not filtered) so we don't duplicate the record-shaping logic.
 *
 * Returns true when a session was relaunched; false when the row is not
 * resumable (no resumable agentType / no providerSession), in which case the
 * caller should keep its prior inert behavior.
 */
export function resumeRetainedAgentByPaneKey(worktreeId: string, paneKey: string): boolean {
  const state = useAppStore.getState()
  const records = collectSleepingAgentSessionRecordsForWorktree(state, worktreeId, [paneKey])
  const record = records[paneKey]
  if (!record) {
    return false
  }
  return launchSleepingAgentSession(record)
}

export function resumeSleepingAgentSessionsForWorktree(worktreeId: string): number {
  const records = Object.values(useAppStore.getState().sleepingAgentSessionsByPaneKey)
    .filter((record) => record.worktreeId === worktreeId)
    // Why: pane-owned captures (#5232/#5626) cover panes that still exist in
    // the restored session. Those panes own their own recovery — warm reattach
    // when the daemon kept the agent alive, or pane-level cold-restore resume.
    .filter((record) => record.origin !== 'quit' && record.origin !== 'live')
    .sort((a, b) => a.capturedAt - b.capturedAt || a.updatedAt - b.updatedAt)

  let launched = 0
  for (const record of records) {
    if (launchSleepingAgentSession(record)) {
      launched += 1
    }
  }
  return launched
}
