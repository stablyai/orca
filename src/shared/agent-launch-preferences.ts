import type { AgentLaunchPreferences } from './agent-session-host-authority'

/** Share model/effort/mode conversion so structured and terminal launches read identical preferences. */
export function toAgentLaunchPreferences(
  sessionOptions: Readonly<Record<string, unknown>> | null | undefined
): AgentLaunchPreferences | undefined {
  if (!sessionOptions) {
    return undefined
  }
  const readString = (key: keyof AgentLaunchPreferences): string | undefined => {
    const value = sessionOptions[key]
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
  }
  const model = readString('model')
  const effort = readString('effort')
  const mode = readString('mode')
  const preferences: AgentLaunchPreferences = {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(mode ? { mode } : {})
  }
  return Object.keys(preferences).length > 0 ? preferences : undefined
}
