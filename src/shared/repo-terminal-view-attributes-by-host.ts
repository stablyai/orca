/**
 * Per themed project, the attributes its panes paint, grouped by the execution host the project
 * lives on. The same map in main's pre-load and the renderer's per-project publish, so a hidden
 * PTY on any host answers OSC 4/10/11/12 and ?996n byte-identically before and after the
 * renderer's publish. Malformed entries are dropped per project; a host with no themed project
 * is absent (every reader treats absent and empty alike).
 */
import type { Repo } from './repo-types'
import { normalizeRepoTerminalThemeOverrides } from './repo-terminal-theme'
import { applyRepoTerminalThemeOverride } from './repo-terminal-theme-settings'
import { getRepoTerminalThemeHostId } from './terminal-theme-execution-host'
import type { TerminalViewAttributes } from './terminal-view-attributes'
import {
  resolveTerminalViewAttributes,
  type TerminalViewAttributesRepo,
  type TerminalViewAttributesSettings
} from './terminal-view-attributes-composition'

/** Execution host id → repo id → the attributes that project's panes paint. */
export type RepoTerminalViewAttributesByHost = Record<
  string,
  Record<string, TerminalViewAttributes>
>

/** What one project's panes paint, or null when the project inherits the global theme. */
export function resolveRepoTerminalViewAttributes(
  settings: TerminalViewAttributesSettings,
  repo: Pick<Repo, 'terminalTheme'>,
  systemPrefersDark: boolean
): TerminalViewAttributes | null {
  const paneSettings = applyRepoTerminalThemeOverride(
    settings,
    normalizeRepoTerminalThemeOverrides(repo.terminalTheme)
  )
  return paneSettings === settings
    ? null
    : resolveTerminalViewAttributes(paneSettings, systemPrefersDark)
}

export function resolveRepoTerminalViewAttributesByHost(
  settings: TerminalViewAttributesSettings,
  repos: readonly TerminalViewAttributesRepo[],
  systemPrefersDark: boolean
): RepoTerminalViewAttributesByHost {
  const entriesByHost = new Map<string, [string, TerminalViewAttributes][]>()
  for (const repo of repos) {
    // Why null skips: a paired-runtime row's PTYs are answered by that runtime, not by this app.
    const hostId = getRepoTerminalThemeHostId(repo)
    if (!hostId) {
      continue
    }
    const attributes = resolveRepoTerminalViewAttributes(settings, repo, systemPrefersDark)
    if (!attributes) {
      continue
    }
    const entries = entriesByHost.get(hostId) ?? []
    entries.push([repo.id, attributes])
    entriesByHost.set(hostId, entries)
  }
  // Why fromEntries: it defines own keys, so a `__proto__` repo id cannot swap the prototype.
  return Object.fromEntries(
    Array.from(entriesByHost, ([hostId, entries]) => [hostId, Object.fromEntries(entries)])
  )
}
