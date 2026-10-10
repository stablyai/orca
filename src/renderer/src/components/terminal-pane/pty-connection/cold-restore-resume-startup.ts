import { useAppStore } from '@/store'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { buildAgentResumeStartupPlan } from '@/lib/tui-agent-startup'
import { resolveAgentResumeLaunchTarget } from '@/lib/agent-resume-launch-target'
import {
  agentResumeOriginNamesAnotherExecutionHost,
  sleepingRecordNamesAnotherExecutionHost
} from '@/lib/sleeping-record-execution-host-scope'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../../../shared/tui-agent-launch-defaults'
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
    // Why: this is the second issuer of `--resume`, and the one that handles a quit/live record
    // whose pane still exists — the sweep hands those here rather than launching them. A session id
    // names a transcript on the machine that captured it, so replaying one over a pane now attached
    // to a different host answers `No conversation found`. Returning null leaves the pane with a
    // plain shell and the record intact, which the user can resume by hand.
    //
    // Two sources are consulted because either can be the one that knows. `session.executionHostId`
    // is the pane's own transport and is authoritative when set, but it is still unresolved on an
    // early reattach frame — and failing open on that frame is precisely when a wrong resume slips
    // out. The catalog's answer for the record's worktree covers that window.
    if (
      agentResumeOriginNamesAnotherExecutionHost(
        useLiveEntry ? entry.connectionId : sleepingRecord?.connectionId,
        session.executionHostId
      ) ||
      (sleepingRecord && sleepingRecordNamesAnotherExecutionHost(sleepingRecord, state))
    ) {
      return null
    }
    const matchingSleepingLaunchConfig =
      sleepingRecord?.launchConfig &&
      (!useLiveEntry ||
        (sleepingRecord.agent === agent &&
          agentProviderSessionsEqual(agent, sleepingRecord.providerSession, providerSession)))
        ? sleepingRecord.launchConfig
        : undefined
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
    const startupPlan = buildAgentResumeStartupPlan({
      agent,
      providerSession,
      cmdOverrides: state.settings?.agentCmdOverrides ?? {},
      agentArgs:
        launchConfig !== undefined
          ? launchConfig.agentArgs
          : resolveTuiAgentLaunchArgs(agent, state.settings?.agentDefaultArgs),
      agentEnv:
        launchConfig !== undefined
          ? launchConfig.agentEnv
          : resolveTuiAgentLaunchEnv(agent, state.settings?.agentDefaultEnv),
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
