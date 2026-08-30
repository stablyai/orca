import { useAppStore } from '@/store'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { buildAgentResumeStartupPlan } from '@/lib/tui-agent-startup'
import { resolveAgentResumeLaunchTarget } from '@/lib/agent-resume-launch-target'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv,
  stripYoloTuiAgentLaunchArgs,
  stripYoloTuiAgentLaunchCommand,
  stripYoloTuiAgentLaunchEnv
} from '../../../../../shared/tui-agent-launch-defaults'
import { resolveSleepingAgentResumeDirectory } from '@/lib/sleeping-agent-resume-directory'
import {
  agentProviderSessionsEqual,
  isResumableTuiAgent,
  normalizeAgentProviderSession
} from '../../../../../shared/agent-session-resume'

import type { ColdRestoreAgentResumeStartup } from './fresh-spawn-types'

import type { ConnectPanePtySession } from './connect-pane-pty-session'
import { resolveStartupShell } from '../../../../../shared/tui-agent-startup-shell'

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
    const resumeSource = useLiveEntry ? entry : sleepingRecord
    if (!resumeSource) {
      return null
    }
    const resumeDirectory = resolveSleepingAgentResumeDirectory(resumeSource, session.connectionId)
    const launchConfig =
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
    const configuredAgentArgs =
      launchConfig !== undefined
        ? launchConfig.agentArgs
        : resolveTuiAgentLaunchArgs(agent, state.settings?.agentDefaultArgs)
    const configuredAgentEnv =
      launchConfig !== undefined
        ? launchConfig.agentEnv
        : resolveTuiAgentLaunchEnv(agent, state.settings?.agentDefaultEnv)
    const resumeShell = resolveStartupShell(resumeTarget.platform, resumeTarget.shell)
    const agentArgs =
      resumeDirectory.kind === 'unknown'
        ? stripYoloTuiAgentLaunchArgs(agent, configuredAgentArgs, resumeShell)
        : configuredAgentArgs
    const agentEnv =
      resumeDirectory.kind === 'unknown'
        ? stripYoloTuiAgentLaunchEnv(agent, configuredAgentEnv)
        : configuredAgentEnv
    const configuredCmdOverrides = state.settings?.agentCmdOverrides ?? {}
    const configuredCommand = configuredCmdOverrides[agent]
    const cmdOverrides =
      resumeDirectory.kind === 'unknown' && configuredCommand
        ? {
            ...configuredCmdOverrides,
            [agent]: stripYoloTuiAgentLaunchCommand(agent, configuredCommand, resumeShell)
          }
        : configuredCmdOverrides
    const configuredAgentCommand = launchConfig?.agentCommand
    const agentCommand =
      resumeDirectory.kind === 'unknown' && configuredAgentCommand
        ? stripYoloTuiAgentLaunchCommand(agent, configuredAgentCommand, resumeShell)
        : configuredAgentCommand
    const startupPlan = buildAgentResumeStartupPlan({
      agent,
      providerSession,
      cmdOverrides,
      agentArgs,
      agentEnv,
      ...(agentCommand ? { agentCommand } : {}),
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
      ...(resumeDirectory.kind === 'agent-reported' ? { cwd: resumeDirectory.cwd } : {}),
      env: {
        ...startupPlan.env,
        ORCA_AGENT_LAUNCH_TOKEN: coldRestoreLaunchToken
      },
      launchConfig: startupPlan.launchConfig,
      resumeProviderSession: providerSession,
      launchToken: coldRestoreLaunchToken,
      ...(launchConfig || resumeDirectory.kind === 'unknown'
        ? { agentArgsOverride: agentArgs }
        : {}),
      useLiveEntry: Boolean(useLiveEntry),
      hasSleepingRecord: Boolean(sleepingRecord),
      sleepingRecordEntry
    }
  }
}
