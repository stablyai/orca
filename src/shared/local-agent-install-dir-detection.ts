import path from 'node:path'
import { resolveCliCommands } from './node-cli-command-resolution'

// Why: detection may precede shell-PATH hydration, but the fallback stays bounded.
export function resolveCommandsInInstallDirs(
  commands: readonly string[],
  /** The PATH detection searched; defaults to this process's own. */
  pathEnv?: string,
  options?: { skipPathSearch?: boolean }
): Map<string, string> {
  const resolved = new Map<string, string>()
  if (commands.length === 0) {
    return resolved
  }
  try {
    const resolvedCommands = resolveCliCommands(commands, {
      ...(pathEnv === undefined ? {} : { pathEnv }),
      ...(options?.skipPathSearch ? { skipPathSearch: true } : {})
    })
    for (const command of commands) {
      const candidate = resolvedCommands.get(command) ?? command
      if (path.isAbsolute(candidate)) {
        resolved.set(command, candidate)
      }
    }
  } catch {
    // Why: an unreadable install dir means "not found", never a thrown detection.
  }
  return resolved
}

export function detectCommandsInInstallDirs(
  commands: readonly string[],
  pathEnv?: string,
  options?: { skipPathSearch?: boolean }
): Set<string> {
  return new Set(resolveCommandsInInstallDirs(commands, pathEnv, options).keys())
}
