import { parseExecutionHostId } from '../../../shared/execution-host'
import { remoteExecutionPlatform } from '../../../shared/agent-launch-runtime'
import { isWslUncPath } from '../../../shared/wsl-paths'
import { buildAgentTerminalResumePlan } from '../../../shared/agent-terminal-resume-plan'
import type { AgentTerminalResume } from '../../../shared/agent-terminal-resume'
import {
  isResumableTuiAgent,
  type AgentProviderSessionMetadata
} from '../../../shared/agent-session-resume'
import type { TuiAgent } from '../../../shared/tui-agent'
import { useAppStore } from '@/store'
import { getLocalProjectExecutionRuntimeContext } from './local-preflight-context'
import {
  getExecutionHostIdForWorktree,
  runtimeEnvironmentIdOrLocalUnlessTwin
} from './worktree-runtime-owner'
import {
  resolveAgentResumeLaunchTarget,
  resolveSshHostReportedPlatform
} from './agent-resume-launch-target'

/** Old execution hosts still receive the prepared request their decoder understands. */
export function prepareLegacyAgentTerminalResume(args: {
  worktreeId: string
  agent: TuiAgent | undefined
  providerSession: AgentProviderSessionMetadata | undefined
  resume: AgentTerminalResume
  cwd?: string
  shellOverride?: string
}) {
  if (!args.agent || !isResumableTuiAgent(args.agent) || !args.providerSession) {
    throw new Error('agent_launch_request_invalid')
  }
  const state = useAppStore.getState()
  const worktree = state.getKnownWorktreeById(args.worktreeId)
  const repo = worktree ? state.repos.find((row) => row.id === worktree.repoId) : undefined
  const executionHostId = getExecutionHostIdForWorktree(state, args.worktreeId)
  const target = resolveAgentResumeLaunchTarget({
    projectRuntime: getLocalProjectExecutionRuntimeContext(state, args.worktreeId),
    connectionId: repo?.connectionId,
    executionHostId,
    worktreePath: worktree?.path,
    terminalWindowsShell: state.settings?.terminalWindowsShell,
    tabShellOverride: args.shellOverride,
    remotePlatform: resolveSshHostReportedPlatform(
      state,
      executionHostId,
      runtimeEnvironmentIdOrLocalUnlessTwin(state, args.worktreeId)
    )
  })
  const plan = buildAgentTerminalResumePlan({
    agent: args.agent,
    providerSession: args.providerSession,
    resume: args.resume,
    settings: state.settings ?? {},
    isRemote: Boolean(repo?.connectionId),
    runtime: {
      platform:
        parseExecutionHostId(executionHostId)?.kind === 'runtime' && worktree?.path
          ? isWslUncPath(worktree.path)
            ? 'linux'
            : remoteExecutionPlatform(worktree.path)
          : target.platform,
      pty: {
        shellOverride:
          target.shell === 'cmd'
            ? 'cmd.exe'
            : target.shell === 'powershell'
              ? 'powershell.exe'
              : undefined,
        terminalWindowsWslDistro: null
      }
    },
    launchCwd: args.cwd ?? worktree?.path
  })
  if (!plan) {
    throw new Error('agent_launch_request_invalid')
  }
  return {
    command: plan.launchCommand,
    env: plan.env,
    launchConfig: plan.launchConfig,
    startupCommandDelivery: plan.startupCommandDelivery
  }
}
