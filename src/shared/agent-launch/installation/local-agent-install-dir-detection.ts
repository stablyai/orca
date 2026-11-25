import path from 'node:path'
import { resolveCliCommandsAsync } from '../../shell/command-resolution/node-cli-command-async-resolution'

// Why: detection may precede shell-PATH hydration, but the fallback stays bounded.
export async function detectCommandsInInstallDirs(
  commands: readonly string[],
  /** The PATH detection searched; defaults to this process's own. */
  pathEnv?: string,
  options?: { skipPathSearch?: boolean }
): Promise<Map<string, string>> {
  if (commands.length === 0) {
    return new Map()
  }
  try {
    const resolvedCommands = await resolveCliCommandsAsync(commands, {
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
