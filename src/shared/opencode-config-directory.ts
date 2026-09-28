import { homedir } from 'node:os'
import { join } from 'node:path'

/** OpenCode's Global.config follows XDG_CONFIG_HOME on every supported host. */
export function resolveOpenCodeConfigDirectory(
  environment: NodeJS.ProcessEnv | Record<string, string> = process.env,
  homeDirectory = homedir()
): string {
  return join(environment.XDG_CONFIG_HOME?.trim() || join(homeDirectory, '.config'), 'opencode')
}
