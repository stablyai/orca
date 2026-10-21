/**
 * Scrub-safe aliases for the two pane-identity env vars whose NAMES some agent harnesses
 * refuse to pass through to a hook process.
 *
 * DeepSeek Harness runs command hooks through its own shell executor, which drops every
 * variable whose name contains `KEY`, `TOKEN`, `SECRET` or `PASSWORD` before the hook
 * process starts. That is a reasonable credential-scrub default, and it is not something
 * Orca can turn off — but it takes `ORCA_PANE_KEY` and `ORCA_AGENT_LAUNCH_TOKEN` with it,
 * which are the two values a status hook needs to say *which pane* it is reporting for.
 * Without them the hook has nothing to attribute to and exits without posting, so the pane
 * reads as an agent Orca never hears from.
 *
 * Verified against `@deepseek-ai/dsh` 0.1.5-rc.1 by running a probe hook that printed its
 * own environment: `PROBE_PLAIN`, `PROBE_AUTH`, `PROBE_CREDENTIAL`, `PROBE_HOOK_PORT` and
 * `PROBE_PANE_ID` arrive; `PROBE_KEY`, `PROBE_TOKEN`, `PROBE_SECRET`, `PROBE_PASSWORD` and
 * `PROBE_PANE_KEY` do not.
 *
 * These are aliases, never replacements: the canonical names stay exactly as they are, so
 * every existing agent, script and test keeps reading what it reads today.
 */

/** Alias for `ORCA_PANE_KEY`. */
export const ORCA_SCRUB_SAFE_PANE_ENV = 'ORCA_AGENT_PANE' as const

/** Alias for `ORCA_AGENT_LAUNCH_TOKEN`. */
export const ORCA_SCRUB_SAFE_LAUNCH_ENV = 'ORCA_AGENT_LAUNCH' as const

const ALIASES: readonly (readonly [source: string, alias: string])[] = [
  ['ORCA_PANE_KEY', ORCA_SCRUB_SAFE_PANE_ENV],
  ['ORCA_AGENT_LAUNCH_TOKEN', ORCA_SCRUB_SAFE_LAUNCH_ENV]
]

/**
 * Mirror pane identity onto its scrub-safe aliases, in place.
 *
 * An alias is written only when its source is present, and dropped when the source is
 * absent — a stale alias inherited from a parent pane would attribute this pane's hooks to
 * the wrong row, which is worse than no status at all.
 */
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
