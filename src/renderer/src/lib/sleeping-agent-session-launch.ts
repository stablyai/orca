import { toast } from 'sonner'
import { useAppStore } from '@/store'
import {
  isPersistableQuickCommandRef,
  isQuickCommandStampOnlyLaunchConfig,
  resolveQuickCommandResumeText
} from '../../../shared/quick-command-resume'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
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

export function getResumeLaunchTarget(worktreeId: string): AgentResumeLaunchTarget {
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

// Why: mobile-driven wake runs on the desktop host renderer, so it must create
// the resume tab without stealing the desktop's active worktree/tab/view.
export function launchSleepingAgentSession(
  record: SleepingAgentSessionRecord,
  options?: ResumeSleepingAgentSessionsOptions
): boolean {
  const state = useAppStore.getState()
  const launchConfig = record.launchConfig
  const resumeTarget = getResumeLaunchTarget(record.worktreeId)
  // Why: same Quick Command passthrough as the cold-restore path — a
  // terminal-command wrapper (`ccr muse --resume`) that spawned the tab must
  // be the resume base, resolved live from settings. launchConfig wins when
  // present, otherwise the record-level ref (older tabs whose config predates
  // the stamp, or configs without one).
  const quickCommandRef = {
    quickCommandId: launchConfig?.quickCommandId ?? record.quickCommandId,
    quickCommandLabel: launchConfig?.quickCommandLabel ?? record.quickCommandLabel
  }
  const quickCommandText = resolveQuickCommandResumeText(
    state.settings?.terminalQuickCommands,
    quickCommandRef,
    getRepoIdFromWorktreeId(record.worktreeId)
  )
  const restampedQuickCommandId =
    quickCommandRef.quickCommandId && isPersistableQuickCommandRef(quickCommandRef.quickCommandId)
      ? quickCommandRef.quickCommandId.trim()
      : undefined
  const restampedQuickCommandLabel =
    quickCommandRef.quickCommandLabel &&
    isPersistableQuickCommandRef(quickCommandRef.quickCommandLabel)
      ? quickCommandRef.quickCommandLabel.trim()
      : undefined
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
    ...(isQuickCommandStampOnlyLaunchConfig(launchConfig)
      ? {
          quickCommandFallbackAgentArgs: resolveTuiAgentLaunchArgs(
            record.agent,
            state.settings?.agentDefaultArgs
          ),
          quickCommandFallbackAgentEnv: resolveTuiAgentLaunchEnv(
            record.agent,
            state.settings?.agentDefaultEnv
          )
        }
      : {}),
    ...(launchConfig?.agentCommand ? { agentCommand: launchConfig.agentCommand } : {}),
    ...(launchConfig?.ompResumeFilePath
      ? { ompResumeFilePath: launchConfig.ompResumeFilePath }
      : {}),
    ...(quickCommandText ? { quickCommandText } : {}),
    ...(restampedQuickCommandId ? { quickCommandId: restampedQuickCommandId } : {}),
    ...(restampedQuickCommandLabel ? { quickCommandLabel: restampedQuickCommandLabel } : {}),
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
    // Why: keep the validated Quick Command label on the resumed tab so the
    // NEXT capture still knows this tab belongs to the wrapper.
    ...(restampedQuickCommandLabel ? { quickCommandLabel: restampedQuickCommandLabel } : {}),
    pendingStartup: {
      command: startupPlan.launchCommand,
      ...(startupPlan.env ? { env: startupPlan.env } : {}),
      launchConfig: startupPlan.launchConfig,
      resumeProviderSession: record.providerSession,
      launchAgent: record.agent,
      // Why: a stamp-only config's empty args are placeholders; omitting the
      // override lets a runtime host (which rebuilds stock, not the wrapper)
      // apply its own default args.
      ...(launchConfig && !isQuickCommandStampOnlyLaunchConfig(launchConfig)
        ? { agentArgsOverride: launchConfig.agentArgs }
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
    state.setActiveTabType('terminal', record.worktreeId)
  }
  appendTabToWorktreeOrder(record.worktreeId, tab.id)
  options?.onSessionLaunched?.(tab.id)
  return true
}
