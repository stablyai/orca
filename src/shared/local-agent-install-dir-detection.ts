import path from 'node:path'
import { resolveCliCommands } from './node-cli-command-resolution'

// Why: detection may precede shell-PATH hydration, but the fallback stays bounded.
export function detectCommandsInInstallDirs(commands: readonly string[]): Set<string> {
  if (commands.length === 0) {
    return new Set()
  }
  try {
    const resolvedCommands = resolveCliCommands(commands)
    return new Set(
      commands.filter((command) => path.isAbsolute(resolvedCommands.get(command) ?? command))
    )
  } catch {
    return new Set()
  }
}
