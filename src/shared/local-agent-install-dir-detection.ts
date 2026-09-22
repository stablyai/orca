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
      commands.filter((command) => {
        // Absolute probes are checked directly by isCommandOnPath before this
        // fallback runs. Treating the unresolved probe itself as a successful
        // install-dir resolution would report every absolute alias as installed.
        if (path.isAbsolute(command)) {
          return false
        }
        return path.isAbsolute(resolvedCommands.get(command) ?? command)
      })
    )
  } catch {
    return new Set()
  }
}
