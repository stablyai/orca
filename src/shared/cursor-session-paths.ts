import { homedir } from 'node:os'
import { join } from 'node:path'

export const CURSOR_ACCESS_TOKEN_KEY = 'cursorAuth/accessToken'
export const CURSOR_CACHED_EMAIL_KEY = 'cursorAuth/cachedEmail'

export function resolveCursorGlobalStateDbPath(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir()
): string {
  if (process.platform === 'darwin') {
    return join(
      homeDir,
      'Library',
      'Application Support',
      'Cursor',
      'User',
      'globalStorage',
      'state.vscdb'
    )
  }
  if (process.platform === 'win32') {
    const appData = env.APPDATA?.trim()
    const base = appData && appData.length > 0 ? appData : join(homeDir, 'AppData', 'Roaming')
    return join(base, 'Cursor', 'User', 'globalStorage', 'state.vscdb')
  }
  const configHome = env.XDG_CONFIG_HOME?.trim()
  const base =
    configHome && configHome.length > 0 && !configHome.startsWith('~')
      ? configHome
      : join(homeDir, '.config')
  return join(base, 'Cursor', 'User', 'globalStorage', 'state.vscdb')
}
