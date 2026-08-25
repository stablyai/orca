import type { AgentLaunchPreferences } from './agent-session-host-authority'
import { getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import type { TuiAgent } from './tui-agent'

const MAX_AUTOMATION_LAUNCH_PREFERENCE_LENGTH = 512

export function normalizeAutomationLaunchPreferences(
  value: AgentLaunchPreferences | null | undefined
): AgentLaunchPreferences | null {
  if (!value) {
    return null
  }
  const read = (key: keyof AgentLaunchPreferences): string | undefined => {
    const normalized = value[key]?.trim()
    return normalized ? normalized : undefined
  }
  const model = read('model')
  const effort = read('effort')
  const mode = read('mode')
  const preferences: AgentLaunchPreferences = {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(mode ? { mode } : {})
  }
  return Object.keys(preferences).length > 0 ? preferences : null
}

export function assertAutomationLaunchPreferences(
  agent: TuiAgent,
  value: AgentLaunchPreferences | null | undefined
): AgentLaunchPreferences | null {
  const preferences = normalizeAutomationLaunchPreferences(value)
  if (!preferences) {
    return null
  }
  const catalog = getAgentSessionOptionCatalog(agent)
  if (!catalog?.supportsWorkerLaunchPreferences) {
    throw new Error(`${agent} does not support automation model preferences.`)
  }
  if (preferences.effort && !preferences.model) {
    throw new Error('Automation reasoning effort requires a model preference.')
  }
  for (const value of Object.values(preferences)) {
    if (value.length > MAX_AUTOMATION_LAUNCH_PREFERENCE_LENGTH) {
      throw new Error('Automation launch preference is too long.')
    }
  }
  return preferences
}

export function automationLaunchPreferencesEqual(
  left: AgentLaunchPreferences | null | undefined,
  right: AgentLaunchPreferences | null | undefined
): boolean {
  const normalizedLeft = normalizeAutomationLaunchPreferences(left)
  const normalizedRight = normalizeAutomationLaunchPreferences(right)
  return (
    normalizedLeft?.model === normalizedRight?.model &&
    normalizedLeft?.effort === normalizedRight?.effort &&
    normalizedLeft?.mode === normalizedRight?.mode
  )
}

export function automationLaunchPreferencesToSessionOptions(
  value: AgentLaunchPreferences | null | undefined
): Record<string, string> | undefined {
  const preferences = normalizeAutomationLaunchPreferences(value)
  return preferences ? { ...preferences } : undefined
}

export function automationLaunchPreferenceStartupProps(
  value: AgentLaunchPreferences | null | undefined
): {
  sessionOptions?: Record<string, string>
  sessionOptionsOverrideAgentArgs?: boolean
} {
  const sessionOptions = automationLaunchPreferencesToSessionOptions(value)
  return sessionOptions ? { sessionOptions, sessionOptionsOverrideAgentArgs: true } : {}
}
