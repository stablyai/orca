import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { buildAgentResumeStartupPlan } from '@/lib/tui-agent-startup'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import { reconcileTabOrder } from '@/components/tab-bar/reconcile-order'
import {
  resolveAgentResumeLaunchTarget,
  type AgentResumeLaunchTarget
} from '@/lib/agent-resume-launch-target'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv,
  stripYoloTuiAgentLaunchArgs,
  stripYoloTuiAgentLaunchCommand,
  stripYoloTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import {
  resolveSleepingAgentResumeDirectory,
  type SleepingAgentResumeDirectory
} from '@/lib/sleeping-agent-resume-directory'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { translate } from '@/i18n/i18n'
import { getConnectionIdFromState } from '@/lib/connection-owner-resolution'
import { resolveStartupShell } from '../../../shared/tui-agent-startup-shell'

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

function getResumeLaunchTarget(worktreeId: string): AgentResumeLaunchTarget {
  const state = useAppStore.getState()
  const worktree = state.getKnownWorktreeById(worktreeId)
  const repo = worktree ? state.repos.find((entry) => entry.id === worktree.repoId) : null
  // The resume tab is created without a shell override, so the global Windows shell wins.
  return resolveAgentResumeLaunchTarget({
    projectRuntime: getLocalProjectExecutionRuntimeContext(state, worktreeId),
    connectionId: repo?.connectionId,
    executionHostId: getExecutionHostIdForWorktree(state, worktreeId),
    worktreePath: worktree?.path,
    terminalWindowsShell: state.settings?.terminalWindowsShell
  })
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

/** An unknown directory roots the resume at the worktree, as it always has — but it must
 *  not also hand that session the permission-bypass defaults. The reported failure is a
 *  permissive agent pointed at the wrong tree; dropping the bypass leaves a resumed agent
 *  that has to ask before it acts, which is recoverable in a way the alternative is not. */
function withoutBypassWhenDirectoryUnknown(
  agent: SleepingAgentSessionRecord['agent'],
  agentArgs: string,
  resumeDirectory: SleepingAgentResumeDirectory,
  shell: AgentResumeLaunchTarget['shell']
): string {
  return resumeDirectory.kind === 'unknown'
    ? stripYoloTuiAgentLaunchArgs(agent, agentArgs, shell)
    : agentArgs
}

function withoutBypassEnvWhenDirectoryUnknown(
  agent: SleepingAgentSessionRecord['agent'],
  agentEnv: Record<string, string>,
  resumeDirectory: SleepingAgentResumeDirectory
): Record<string, string> {
  return resumeDirectory.kind === 'unknown' ? stripYoloTuiAgentLaunchEnv(agent, agentEnv) : agentEnv
}

// Why: mobile-driven wake runs on the desktop host renderer, so it must create
// the resume tab without stealing the desktop's active worktree/tab/view.
export function launchSleepingAgentSession(
  record: SleepingAgentSessionRecord,
  options?: ResumeSleepingAgentSessionsOptions
): boolean {
  const state = useAppStore.getState()
  const launchConfig = record.launchConfig
  const resumeTarget = getResumeLaunchTarget(record.worktreeId)
  const resumeDirectory = resolveSleepingAgentResumeDirectory(
    record,
    getConnectionIdFromState(state, record.worktreeId)
  )
  const resumeShell = resolveStartupShell(resumeTarget.platform, resumeTarget.shell)
  const configuredCmdOverrides = state.settings?.agentCmdOverrides ?? {}
  const configuredCommand = configuredCmdOverrides[record.agent]
  const cmdOverrides =
    resumeDirectory.kind === 'unknown' && configuredCommand
      ? {
          ...configuredCmdOverrides,
          [record.agent]: stripYoloTuiAgentLaunchCommand(
            record.agent,
            configuredCommand,
            resumeShell
          )
        }
      : configuredCmdOverrides
  const configuredAgentCommand = launchConfig?.agentCommand
  const agentCommand =
    resumeDirectory.kind === 'unknown' && configuredAgentCommand
      ? stripYoloTuiAgentLaunchCommand(record.agent, configuredAgentCommand, resumeShell)
      : configuredAgentCommand
  const agentArgs = withoutBypassWhenDirectoryUnknown(
    record.agent,
    launchConfig !== undefined
      ? launchConfig.agentArgs
      : resolveTuiAgentLaunchArgs(record.agent, state.settings?.agentDefaultArgs),
    resumeDirectory,
    resumeShell
  )
  const startupPlan = buildAgentResumeStartupPlan({
    agent: record.agent,
    providerSession: record.providerSession,
    cmdOverrides,
    agentArgs,
    agentEnv: withoutBypassEnvWhenDirectoryUnknown(
      record.agent,
      launchConfig !== undefined
        ? launchConfig.agentEnv
        : resolveTuiAgentLaunchEnv(record.agent, state.settings?.agentDefaultEnv),
      resumeDirectory
    ),
    ...(agentCommand ? { agentCommand } : {}),
    ...(launchConfig?.ompResumeFilePath
      ? { ompResumeFilePath: launchConfig.ompResumeFilePath }
      : {}),
    platform: resumeTarget.platform,
    shell: resumeTarget.shell
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
    // Why: the tab's cwd is what `claude --resume` / `codex resume` inherit. Left to the
    // worktree, a session the user started from a subdirectory comes back rooted in a tree
    // it was never about. An unknown directory adds nothing here — it must not become one.
    ...(resumeDirectory.kind === 'agent-reported' ? { startupCwd: resumeDirectory.cwd } : {}),
    pendingStartup: {
      command: startupPlan.launchCommand,
      ...(startupPlan.env ? { env: startupPlan.env } : {}),
      launchConfig: startupPlan.launchConfig,
      resumeProviderSession: record.providerSession,
      launchAgent: record.agent,
      // Why: the runtime spawn path re-derives the agent command from this override, so it
      // carries the SAME args the startup plan used — else the unknown-directory strip above
      // is undone the moment the pane respawns through the runtime.
      ...(launchConfig || resumeDirectory.kind === 'unknown'
        ? { agentArgsOverride: agentArgs }
        : {}),
      ...(startupPlan.startupCommandDelivery
        ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
        : {}),
      showSessionRestoredBanner: true,
      telemetry: {
        agent_kind: tuiAgentToAgentKind(record.agent),
        launch_source: 'sidebar',
        request_kind: 'resume'
      }
    },
    automaticResumeClaim: {
      worktreeId: record.worktreeId,
      launchAgent: record.agent,
      providerSession: record.providerSession
    },
    ...(options?.suppressNavigation ? { activate: false, recordInteraction: false } : {})
  })
  state.clearSleepingAgentSession(record.paneKey)
  if (!options?.suppressNavigation) {
    state.setActiveTabType('terminal')
  }
  appendTabToWorktreeOrder(record.worktreeId, tab.id)
  options?.onSessionLaunched?.(tab.id)
  return true
}
