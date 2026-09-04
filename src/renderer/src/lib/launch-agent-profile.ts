import {
  applyAgentLaunchProfile,
  findAgentLaunchProfile,
  resolveAgentLaunchProfiles
} from '../../../shared/agent-launch-profile/agent-launch-profile'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'

export type NewTabAgentLaunch = {
  agentArgs: string | null
  agentEnv: Record<string, string>
  /** Echoed only when a profile applied, so the host re-validates the same id. */
  launchProfileId?: string
}

/**
 * Resolves the args/env a new agent tab launches with, layering an optional launch profile
 * over the agent defaults. Returns null when `launchProfileId` names no profile for `agent`,
 * which the caller reports like any other unbuildable launch.
 */
export function resolveNewTabAgentLaunch(
  settings:
    | Pick<GlobalSettings, 'agentDefaultArgs' | 'agentDefaultEnv' | 'agentLaunchProfiles'>
    | null
    | undefined,
  agent: TuiAgent,
  agentArgs: string | null | undefined,
  launchProfileId: string | null | undefined
): NewTabAgentLaunch | null {
  const effectiveAgentArgs =
    agentArgs !== undefined
      ? agentArgs
      : resolveTuiAgentLaunchArgs(agent, settings?.agentDefaultArgs)
  const agentEnv = resolveTuiAgentLaunchEnv(agent, settings?.agentDefaultEnv)
  if (!launchProfileId) {
    return { agentArgs: effectiveAgentArgs, agentEnv }
  }
  const profile = findAgentLaunchProfile(
    resolveAgentLaunchProfiles(settings?.agentLaunchProfiles),
    agent,
    launchProfileId
  )
  if (!profile) {
    return null
  }
  const launch = applyAgentLaunchProfile({
    profile,
    agentArgs: effectiveAgentArgs ?? '',
    agentEnv
  })
  return { agentArgs: launch.agentArgs, agentEnv: launch.agentEnv, launchProfileId: profile.id }
}

/**
 * Same resolution for flows that must not block on a stale id: settings can change under an
 * open composer, and its picker repairs itself on the next render, so the default launch is
 * the right answer for the one submit that raced it.
 */
export function resolveAgentLaunchWithProfileFallback(
  settings: Parameters<typeof resolveNewTabAgentLaunch>[0],
  agent: TuiAgent,
  launchProfileId: string | null | undefined
): NewTabAgentLaunch {
  return (
    resolveNewTabAgentLaunch(settings, agent, undefined, launchProfileId) ??
    resolveNewTabAgentLaunch(settings, agent, undefined, null)!
  )
}
