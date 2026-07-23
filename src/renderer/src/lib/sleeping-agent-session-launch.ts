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
import { translate } from '@/i18n/i18n'

export type ResumeSleepingAgentSessionsOptions = {
  suppressNavigation?: boolean
  /** Provider-session claim keys already woken in place by mounted panes
   *  (WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT). Their sleeping records are
   *  cleared only after the in-place spawn succeeds, so the generic resume
   *  must neither launch nor clear them here. */
  skipClaimKeys?: ReadonlySet<string>
  /** Called with the tab id of each freshly launched resume tab, so
   *  navigation-suppressed callers can background-mount exactly those tabs. */
  onSessionLaunched?: (tabId: string) => void
}

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

// Why: mobile-driven wake runs on the desktop host renderer, so it must create
// the resume tab without stealing the desktop's active worktree/tab/view.
export function launchSleepingAgentSession(
  record: SleepingAgentSessionRecord,
  options?: ResumeSleepingAgentSessionsOptions
): boolean {
  const state = useAppStore.getState()
  const launchConfig = record.launchConfig
  const startupPlan = buildAgentResumeStartupPlan({
    agent: record.agent,
    providerSession: record.providerSession,
    cmdOverrides: state.settings?.agentCmdOverrides ?? {},
    agentArgs:
      launchConfig !== undefined
        ? launchConfig.agentArgs
        : resolveTuiAgentLaunchArgs(record.agent, state.settings?.agentDefaultArgs),
    agentEnv:
      launchConfig !== undefined
        ? launchConfig.agentEnv
        : resolveTuiAgentLaunchEnv(record.agent, state.settings?.agentDefaultEnv),
    ...(launchConfig?.agentCommand ? { agentCommand: launchConfig.agentCommand } : {}),
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
    launchAgent: record.agent,
    ...(options?.suppressNavigation ? { activate: false, recordInteraction: false } : {})
  })
  state.queueTabStartupCommand(tab.id, {
    command: startupPlan.launchCommand,
    ...(startupPlan.env ? { env: startupPlan.env } : {}),
    launchConfig: startupPlan.launchConfig,
    resumeProviderSession: record.providerSession,
    launchAgent: record.agent,
    ...(launchConfig ? { agentArgsOverride: launchConfig.agentArgs } : {}),
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
  state.claimAutomaticAgentResume(tab.id, {
    worktreeId: record.worktreeId,
    launchAgent: record.agent,
    providerSession: record.providerSession
  })
  state.clearSleepingAgentSession(record.paneKey)
  if (!options?.suppressNavigation) {
    state.setActiveTabType('terminal')
  }
  appendTabToWorktreeOrder(record.worktreeId, tab.id)
  options?.onSessionLaunched?.(tab.id)
  return true
}
