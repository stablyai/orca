import { agentPermissionHostPlatform } from '../permissions/agent-permission-env'
import { withoutAgentPermissionGuardSkipEnv } from '../permissions/agent-permission-guard-skip'
import {
  agentPermissionEnv,
  hasTypedAgentPermission,
  PERMISSION_CHOICE_AGENTS
} from '../permissions/tui-agent-permission-choice'
import { resolveStartupShell } from '../startup/tui-agent-startup-shell'
import { resolveLocalWindowsAgentStartupShell } from '../../windows-terminal-shell'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv,
  type AgentLaunchProfileSettings
} from './tui-agent-launch-defaults'

/** Publish composed args/env for older clients that infer permission from text; explicit keys prevent fallback to their built-in defaults. */
export function composeAgentLaunchProfile(
  settings: AgentLaunchProfileSettings,
  platform: NodeJS.Platform | null | undefined = agentPermissionHostPlatform()
): Required<Pick<AgentLaunchProfileSettings, 'agentDefaultArgs' | 'agentDefaultEnv'>> {
  if (!hasTypedAgentPermission(settings) && settings.agentLaunchChoices === undefined) {
    return {
      agentDefaultArgs: { ...settings.agentDefaultArgs },
      agentDefaultEnv: { ...settings.agentDefaultEnv }
    }
  }
  const argAgents = new Set([
    ...Object.keys(settings.agentDefaultArgs ?? {}),
    ...Object.keys(settings.agentLaunchChoices ?? {}),
    ...PERMISSION_CHOICE_AGENTS
  ])
  const envAgents = new Set([
    ...Object.keys(settings.agentDefaultEnv ?? {}),
    ...PERMISSION_CHOICE_AGENTS.filter(
      (agent) => Object.keys(agentPermissionEnv(agent, 'full-access')).length > 0
    )
  ])
  return {
    agentDefaultArgs: Object.fromEntries(
      [...argAgents].map((agent) => [
        agent,
        resolveTuiAgentLaunchArgs(
          agent,
          settings,
          undefined,
          resolveStartupShell(
            platform ?? agentPermissionHostPlatform(),
            resolveLocalWindowsAgentStartupShell({
              platform: platform ?? agentPermissionHostPlatform(),
              isRemote: false,
              terminalWindowsShell: settings.terminalWindowsShell
            })
          )
        )
      ])
    ),
    // Orca's guard-skip entry stays out: this profile is what clients without the opt-in read, and
    // it is also the Environment field they edit, which must only ever hold the user's own names.
    agentDefaultEnv: Object.fromEntries(
      [...envAgents].map((agent) => [
        agent,
        withoutAgentPermissionGuardSkipEnv(
          resolveTuiAgentLaunchEnv(agent, settings, platform),
          platform
        )
      ])
    )
  }
}
