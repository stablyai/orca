/**
 * Classify which opencode CLI generation a `--version` probe reports.
 *
 * Why: the opencode v2 npm package (`@opencode/cli`) declares BOTH `opencode`
 * and `opencode2` bins for the same v2 binary, while v1 (`opencode-ai`) declares
 * only `opencode`. Detection that keys on the command name alone therefore
 * reports the v1 entry on a v2-only machine (#24987). v1 prints a bare
 * `1.18.x`; v2 prints `opencode v2.0.x`.
 */
export type OpenCodeCliGeneration = 'v1' | 'v2'

const OPEN_CODE_VERSION_PATTERN = /^(?:opencode\s+)?v?([12])\.\d+\.\d+(?:[-+][\w.-]+)?$/i

/** The generation a `--version` output names, or null when it is unrecognised. */
export function classifyOpenCodeCliGeneration(versionOutput: string): OpenCodeCliGeneration | null {
  // Why per line: WSL login shells and relay stdout+stderr can prepend a banner,
  // and only the version line itself carries the generation.
  for (const line of versionOutput.split(/\r?\n/)) {
    const major = OPEN_CODE_VERSION_PATTERN.exec(line.trim())?.[1]
    if (major === '1') {
      return 'v1'
    }
    if (major === '2') {
      return 'v2'
    }
  }
  return null
}
