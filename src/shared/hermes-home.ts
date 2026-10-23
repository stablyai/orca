import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveAbsoluteDirOverride } from './absolute-dir-override'

export function resolveHermesHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolveAbsoluteDirOverride(env.HERMES_HOME, resolveDefaultHermesHomeDir({ env }))
}

export function resolveDefaultHermesHomeDir(
  input: { homeDir?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}
): string {
  const platform = input.platform ?? process.platform
  const homeDir = input.homeDir ?? homedir()
  const env = input.env ?? process.env
  const suffix = env.HERMES_DATA_DIR_SUFFIX ?? ''
  if (platform !== 'win32') {
    return join(homeDir, `.hermes${suffix}`)
  }
  const localAppData = resolveAbsoluteDirOverride(
    env.LOCALAPPDATA,
    join(homeDir, 'AppData', 'Local'),
    platform
  )
  return join(localAppData, `hermes${suffix}`)
}
