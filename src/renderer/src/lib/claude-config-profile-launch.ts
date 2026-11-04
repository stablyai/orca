import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import {
  claudeConfigProfileLaunchEnv,
  type ClaudeConfigProfile
} from '../../../shared/claude-config-profiles'

/** `undefined`: an ordinary launch. `null`: refuse, since running without the folder would use another login. */
export function claudeConfigProfileLaunchEnvFor(args: {
  agent: TuiAgent
  profileId: string | undefined
  profiles: readonly ClaudeConfigProfile[] | undefined
  local: boolean
}): Record<string, string> | null | undefined {
  if (args.profileId === undefined) {
    return undefined
  }
  const profile = args.profiles?.find((candidate) => candidate.id === args.profileId)
  return profile && args.agent === 'claude' && args.local
    ? claudeConfigProfileLaunchEnv(profile)
    : null
}
