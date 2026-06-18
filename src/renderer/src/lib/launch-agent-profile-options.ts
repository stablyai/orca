import { resolveAgentLaunchProfileStartupOptions } from '../../../shared/agent-launch-profiles'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import type { GlobalSettings, TuiAgent } from '../../../shared/types'

export type ResolvedAgentLaunchOptions = {
  cmdOverrides: Partial<Record<TuiAgent, string>>
  agentArgs: string | null
  agentEnv: Record<string, string>
}

export function resolveAgentLaunchOptions(args: {
  agent: TuiAgent
  agentArgs?: string | null
  profileId?: string | null
  settings?: GlobalSettings | null
}): ResolvedAgentLaunchOptions | null {
  const { agent, agentArgs, profileId, settings } = args
  let cmdOverrides = settings?.agentCmdOverrides ?? {}
  let resolvedAgentArgs =
    agentArgs !== undefined
      ? agentArgs
      : resolveTuiAgentLaunchArgs(agent, settings?.agentDefaultArgs)
  let agentEnv = resolveTuiAgentLaunchEnv(agent, settings?.agentDefaultEnv)
  if (!profileId?.trim()) {
    return { cmdOverrides, agentArgs: resolvedAgentArgs, agentEnv }
  }
  const profileOptions = resolveAgentLaunchProfileStartupOptions({
    agent,
    profileId,
    selectionKind: 'explicit',
    profiles: settings?.agentLaunchProfiles,
    agentCmdOverrides: settings?.agentCmdOverrides,
    agentDefaultArgs: settings?.agentDefaultArgs,
    agentDefaultEnv: settings?.agentDefaultEnv
  })
  if (!profileOptions.ok) {
    return null
  }
  cmdOverrides = profileOptions.cmdOverrides
  if (agentArgs === undefined) {
    resolvedAgentArgs = profileOptions.agentArgs
  }
  agentEnv = profileOptions.agentEnv
  return { cmdOverrides, agentArgs: resolvedAgentArgs, agentEnv }
}
