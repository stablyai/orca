import path from 'node:path'
import { resolveCliCommands } from '../../shell/command-resolution/node-cli-command-resolution'

// Why: detection may precede shell-PATH hydration, but the fallback stays bounded.
export function detectCommandsInInstallDirs(
  commands: readonly string[],
  /** The PATH detection searched; defaults to this process's own. */
  pathEnv?: string,
  options?: { skipPathSearch?: boolean }
): Map<string, string> {
  if (commands.length === 0) {
    return new Map()
  }
  try {
    const resolvedCommands = resolveCliCommands(commands, {
      ...(pathEnv === undefined ? {} : { pathEnv }),
      ...(options?.skipPathSearch ? { skipPathSearch: true } : {})
    })
    // Each command found, to the full path it was found at.
    return new Map(
      commands.flatMap((command) => {
        const resolved = resolvedCommands.get(command)
        return resolved && path.isAbsolute(resolved) ? [[command, resolved] as const] : []
      })
    )
  } catch {
    return new Map()
  }
}
