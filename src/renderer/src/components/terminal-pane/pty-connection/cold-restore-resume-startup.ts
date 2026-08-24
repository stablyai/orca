import { useAppStore } from '@/store'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { buildAgentResumeStartupPlan } from '@/lib/tui-agent-startup'
import { resolveAgentResumeLaunchTarget } from '@/lib/agent-resume-launch-target'
import { resolveResumeLaunchInputs } from '../../../../../shared/agent-resume-permission-drop'
import {
  agentProviderSessionsEqual,
  isResumableTuiAgent,
  normalizeAgentProviderSession
} from '../../../../../shared/agent-session-resume'

import type { ColdRestoreAgentResumeStartup } from './fresh-spawn-types'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function bindBuildColdRestoreAgentResumeStartup(session: ConnectPanePtySession): void {
  session.buildColdRestoreAgentResumeStartup = (): ColdRestoreAgentResumeStartup | null => {
    if (session.pendingStartupCommand) {
      return null
    }
    const state = useAppStore.getState()
    const entry = state.agentStatusByPaneKey[session.cacheKey]
    const sleepingRecordEntry = session.getSleepingRecordForPane(state)
    const sleepingRecord = sleepingRecordEntry?.record
    if (session.isLegacyWorkerAutomaticResumeBlocked()) {
      return null
    }
    const useLiveEntry = entry && entry.state !== 'done'
    const agent = useLiveEntry ? entry.agentType : sleepingRecord?.agent
    if (!agent || !isResumableTuiAgent(agent)) {
      return null
    }
    const providerSession = normalizeAgentProviderSession(
      useLiveEntry ? entry.providerSession : sleepingRecord?.providerSession
    )
    if (!providerSession) {
      return null
    }
    const matchingSleepingLaunchConfig =
      sleepingRecord?.launchConfig &&
      (!useLiveEntry ||
        (sleepingRecord.agent === agent &&
          agentProviderSessionsEqual(agent, sleepingRecord.providerSession, providerSession)))
        ? sleepingRecord.launchConfig
        : undefined
    const recordedLaunchConfig =
      (useLiveEntry && entry ? state.getAgentLaunchConfigForStatusEntry(entry) : undefined) ??
      matchingSleepingLaunchConfig
    // Why: the resume line is typed into this pane's live shell, so its quoting must
    // follow the tab's effective Windows shell, not the win32 PowerShell default.
    const resumeTarget = resolveAgentResumeLaunchTarget({
      projectRuntime: session.projectRuntime,
      connectionId: session.connectionId,
      executionHostId: session.executionHostId,
      worktreePath: session.worktree?.path,
      terminalWindowsShell: state.settings?.terminalWindowsShell,
      tabShellOverride: session.shellOverride
    })
    // Why: the recorded config describes the launch this pane started with, so a
    // permission escalation the user has since turned off must not ride along
    // into the restart's resume (#10886).
    const { launchConfig, agentArgs, agentEnv } = resolveResumeLaunchInputs({
      agent,
      launchConfig: recordedLaunchConfig,
      settings: state.settings,
      platform: resumeTarget.platform,
      shell: resumeTarget.shell
    })
    const startupPlan = buildAgentResumeStartupPlan({
      agent,
      providerSession,
      cmdOverrides: state.settings?.agentCmdOverrides ?? {},
      agentArgs,
      agentEnv,
      ...(launchConfig?.agentCommand ? { agentCommand: launchConfig.agentCommand } : {}),
      ...(launchConfig?.ompResumeFilePath
        ? { ompResumeFilePath: launchConfig.ompResumeFilePath }
        : {}),
      platform: resumeTarget.platform,
      shell: resumeTarget.shell
    })
    if (!startupPlan) {
      return null
    }
    const coldRestoreLaunchToken = createBrowserUuid()
    // Why: cold restore means the PTY process is gone but the agent provider
    // session is still resumable, so the replacement spawn must launch it.
    return {
      agent,
      command: startupPlan.launchCommand,
      env: {
        ...startupPlan.env,
        ORCA_AGENT_LAUNCH_TOKEN: coldRestoreLaunchToken
      },
      launchConfig: startupPlan.launchConfig,
      resumeProviderSession: providerSession,
      launchToken: coldRestoreLaunchToken,
      useLiveEntry: Boolean(useLiveEntry),
      hasSleepingRecord: Boolean(sleepingRecord),
      sleepingRecordEntry
    }
  }
}
