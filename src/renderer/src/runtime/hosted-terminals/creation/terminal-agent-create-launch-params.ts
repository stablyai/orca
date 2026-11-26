import { GENERATED_AGENT_LAUNCH_ENV } from '../../../../../shared/agent-launch/startup/generated-agent-launch-inputs'
import {
  buildHermesQueryCommand,
  ORCA_HERMES_STARTUP_QUERY_ARGV_ENV,
  readGeneratedHermesQueryArgv
} from '../../../../../shared/agent-launch/startup/hermes-startup-query'
import {
  HERMES_STARTUP_QUERY_ARGV_CAPABILITY,
  QUEUED_AGENT_LAUNCH_CAPABILITY
} from '../../../../../shared/terminal/runtime-policy/terminal-runtime-capabilities'
import { ensureRuntimeEnvironmentCompatible } from '../../rpc/compatibility/runtime-compatibility-probe'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'
import type { AgentDetectionReply } from '../../../store/slices/agent-inventory/managed-agent-launch-commands'
import { worktreeIdFromRuntimeSelector } from '../../rpc/targets/runtime-worktree-selector'
import type { WorktreeStartupLaunch } from '../../../../../shared/worktree/creation/launch-types'
import type { SleepingAgentLaunchConfig } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'

type TerminalAgentLaunchParams = {
  worktree: string
  command?: string
  env?: Record<string, string>
  generatedAgentLaunch?: string
  hermesStartupQueryArgv?: string
}

export function terminalAgentCreateLaunchParams(
  command: string | undefined,
  env: Record<string, string> | undefined
): Omit<TerminalAgentLaunchParams, 'worktree'> {
  if (!env || !(GENERATED_AGENT_LAUNCH_ENV in env || ORCA_HERMES_STARTUP_QUERY_ARGV_ENV in env)) {
    return { ...(command !== undefined ? { command } : {}), ...(env ? { env } : {}) }
  }
  const {
    [GENERATED_AGENT_LAUNCH_ENV]: generatedAgentLaunch,
    [ORCA_HERMES_STARTUP_QUERY_ARGV_ENV]: hermesStartupQueryArgv,
    ...paneEnv
  } = env
  return {
    ...(command !== undefined ? { command } : {}),
    ...(Object.keys(paneEnv).length ? { env: paneEnv } : {}),
    ...(command && generatedAgentLaunch ? { generatedAgentLaunch } : {}),
    ...(command && hermesStartupQueryArgv ? { hermesStartupQueryArgv } : {})
  }
}

export function worktreeAgentStartupParams(startup: WorktreeStartupLaunch) {
  const {
    command: startupCommand,
    env: startupEnv,
    ...rebuild
  } = terminalAgentCreateLaunchParams(startup.command, startup.env)
  return {
    startupCommand,
    ...(startupEnv ? { startupEnv } : {}),
    ...rebuild
  }
}

/** Older hosts can report an outside-PATH Hermes but cannot receive the new request field. */
export async function withLegacyHermesExecutable<
  T extends TerminalAgentLaunchParams & { launchConfig?: SleepingAgentLaunchConfig }
>(params: T, environmentId: string, pairingRevision: number | undefined): Promise<T> {
  if (
    !params.command ||
    !params.hermesStartupQueryArgv ||
    params.launchConfig?.commandProvenance !== 'generated'
  ) {
    return params
  }
  const status = await ensureRuntimeEnvironmentCompatible(environmentId, {
    expectedEnvironmentPairingRevision: pairingRevision
  }).catch(() => null)
  if (
    !status ||
    status.capabilities?.includes(HERMES_STARTUP_QUERY_ARGV_CAPABILITY) ||
    !status.capabilities?.includes(QUEUED_AGENT_LAUNCH_CAPABILITY) ||
    Object.keys(params.env ?? {}).some((key) => key.toLowerCase() === 'path')
  ) {
    return params
  }
  const shell = params.command.startsWith('powershell.exe ') ? 'powershell' : 'posix'
  const argv = readGeneratedHermesQueryArgv(params.hermesStartupQueryArgv, params.command, shell)
  const worktreeId = worktreeIdFromRuntimeSelector(params.worktree)
  if (!argv || !worktreeId) {
    return params
  }
  const reply = await callRuntimeRpc<AgentDetectionReply>(
    { kind: 'environment', environmentId },
    'preflight.detectAgents',
    { worktreeId, withManagedAgentCommands: true },
    {
      expectedEnvironmentPairingRevision: pairingRevision,
      expectedEnvironmentRuntimeId: status.runtimeId
    }
  ).catch(() => undefined)
  const executable =
    reply && typeof reply === 'object' && 'agents' in reply ? reply.outsidePath?.hermes : undefined
  if (typeof executable !== 'string' || !executable) {
    return params
  }
  const selectedArgv = [executable, ...argv.slice(1)]
  return {
    ...params,
    command: buildHermesQueryCommand(selectedArgv, shell),
    hermesStartupQueryArgv: JSON.stringify(selectedArgv)
  }
}
