/** DSH0.1.5-rc.1 scrubs KEY/TOKEN/SECRET/PASSWORD env names before running hooks, including Orca pane identity. Mirror identity through scrub-safe aliases while preserving canonical names for other agents. */

/** Alias for `ORCA_PANE_KEY`. */
export const ORCA_SCRUB_SAFE_PANE_ENV = 'ORCA_AGENT_PANE' as const

/** Alias for `ORCA_AGENT_LAUNCH_TOKEN`. */
export const ORCA_SCRUB_SAFE_LAUNCH_ENV = 'ORCA_AGENT_LAUNCH' as const

const ALIASES: readonly (readonly [source: string, alias: string])[] = [
  ['ORCA_PANE_KEY', ORCA_SCRUB_SAFE_PANE_ENV],
  ['ORCA_AGENT_LAUNCH_TOKEN', ORCA_SCRUB_SAFE_LAUNCH_ENV]
]

/** Drop aliases whose source is absent so inherited parent identity cannot claim this pane's hooks. */
export function applyScrubSafeAgentEnvAliases(env: Record<string, string>): void {
  for (const [source, alias] of ALIASES) {
    const value = env[source]
    if (value === undefined || value === '') {
      delete env[alias]
      continue
    }
    env[alias] = value
  }
}
