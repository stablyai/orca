const SESSION_POOL_DEFAULT_MAX = 500
const PERSISTED_HISTORY_CAP = 2000

/** In-memory, per-pane pool of commands run this session; contract: index 0 is most recent (see terminal-autosuggest-engine.ts). */
export function createTerminalAutosuggestSessionPool(maxSize: number = SESSION_POOL_DEFAULT_MAX): {
  push: (command: string) => void
  getAll: () => readonly string[]
} {
  let commands: string[] = []
  return {
    push: (command: string) => {
      commands = [command, ...commands.filter((existing) => existing !== command)]
      if (commands.length > maxSize) {
        commands = commands.slice(0, maxSize)
      }
    },
    getAll: () => commands
  }
}

/** Shells whose HISTFILE this app writes today (see src/main/terminal-history.ts historyFilename). */
export type ParsableShellKind = 'bash' | 'zsh'

/** Resolve the parsable shell kind from a shell binary path, or null when the
 *  shell has no HISTFILE format this app parses (fish/pwsh/cmd/unknown).
 *  Mirrors resolveShellKind's basename + prefix match (src/main/terminal-history.ts)
 *  but restricted to the two shells this renderer knows how to parse — kept
 *  renderer-local (no node:path) so it works under contextIsolation. */
export function resolveParsableShellKindFromPath(shellPath: string): ParsableShellKind | null {
  const name = shellPath.split(/[/\\]/).pop()?.toLowerCase() ?? ''
  if (name.startsWith('zsh')) {
    return 'zsh'
  }
  if (name.startsWith('bash')) {
    return 'bash'
  }
  return null
}

/** Parses a HISTFILE's raw content into most-recent-first commands, capped at PERSISTED_HISTORY_CAP. */
export function parseShellHistoryContent(content: string, shell: ParsableShellKind): string[] {
  const rawLines = content.split('\n').filter((line) => line.length > 0)
  const commands =
    shell === 'zsh'
      ? rawLines.map((line) => {
          const match = /^: \d+:\d+;(.*)$/.exec(line)
          return match ? match[1] : line
        })
      : rawLines
  const mostRecentFirst = commands.toReversed()
  return mostRecentFirst.slice(0, PERSISTED_HISTORY_CAP)
}
