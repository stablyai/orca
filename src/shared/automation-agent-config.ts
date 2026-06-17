import type { AutomationAgentConfig } from './automations-types'

function normalizeEnvRecord(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const next: Record<string, string> = {}
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const key = rawKey.trim()
    // Why: a blank key or non-string value can never become a valid env entry,
    // so drop it rather than persist a slot that would break the spawn.
    if (!key || typeof rawValue !== 'string') {
      continue
    }
    next[key] = rawValue
  }
  return Object.keys(next).length > 0 ? next : null
}

/** Normalize a per-automation agent config to a canonical form, collapsing an
 *  all-empty config to null so storage and equality checks stay simple. */
export function normalizeAutomationAgentConfig(
  value: AutomationAgentConfig | null | undefined
): AutomationAgentConfig | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const launchArgs =
    typeof value.launchArgs === 'string' && value.launchArgs.trim().length > 0
      ? value.launchArgs.trim()
      : null
  const model =
    typeof value.model === 'string' && value.model.trim().length > 0 ? value.model.trim() : null
  const env = normalizeEnvRecord(value.env)
  if (!launchArgs && !model && !env) {
    return null
  }
  const normalized: AutomationAgentConfig = {}
  if (launchArgs) {
    normalized.launchArgs = launchArgs
  }
  if (env) {
    normalized.env = env
  }
  if (model) {
    normalized.model = model
  }
  return normalized
}
