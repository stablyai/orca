// Why: alternate Claude config dirs (`CLAUDE_CONFIG_DIR=$HOME/.claude-<name>`)
// are identified purely by directory-name convention — never by vendor names in
// code (dir basenames are user-observed data). Shared between main (config-dir
// discovery/install) and the renderer (sidebar flavor label).

/** Matches a home-dir entry named `.claude-<flavor>` or `.claude.<flavor>`.
 *  `.claude` itself (no separator + suffix) intentionally does not match. */
export const CLAUDE_FLAVOR_CONFIG_DIR_PATTERN = /^\.claude[-.](.+)$/

/** Derive the short flavor label from a config-dir path: `~/.claude-grok` →
 *  "grok", `/home/u/.claude.foo` → "foo". Returns null for the default
 *  `.claude`, non-matching basenames, or empty input. */
export function deriveClaudeConfigDirLabel(configDir: string | null | undefined): string | null {
  if (!configDir) {
    return null
  }
  // Why: split on both separators — the path may come from a Windows host.
  const segments = configDir.split(/[\\/]/)
  let basename = ''
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i].trim()
    if (segment.length > 0) {
      basename = segment
      break
    }
  }
  const label = CLAUDE_FLAVOR_CONFIG_DIR_PATTERN.exec(basename)?.[1].trim() ?? ''
  return label.length > 0 ? label : null
}
