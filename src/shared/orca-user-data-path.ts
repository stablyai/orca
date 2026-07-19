// Default Electron userData path for the Orca app, resolvable WITHOUT the
// electron module. The standalone `orca` CLI (plain Node under
// ELECTRON_RUN_AS_NODE; packaged installs ship no electron in node_modules)
// uses this to find the same per-install files the app writes via
// app.getPath('userData').

import { homedir } from 'node:os'
import { join } from 'node:path'

export function getDefaultOrcaUserDataPath(
  platform: NodeJS.Platform = process.platform,
  homeDir = homedir()
): string {
  // Why: in dev mode (and for parallel Orca instances), the Electron app writes
  // to a separate userData directory (e.g. `orca-dev`). This env var lets
  // out-of-process callers target a specific instance.
  if (process.env.ORCA_USER_DATA_PATH) {
    return process.env.ORCA_USER_DATA_PATH
  }
  if (platform === 'darwin') {
    return join(homeDir, 'Library', 'Application Support', 'orca')
  }
  if (platform === 'win32') {
    const appData = process.env.APPDATA
    if (!appData) {
      throw new Error('APPDATA is not set, so the Orca user data path cannot be resolved.')
    }
    return join(appData, 'orca')
  }
  // Why: mirrors Electron's default userData base instead of inventing a
  // CLI-specific config path, so both processes agree on the location.
  return join(process.env.XDG_CONFIG_HOME || join(homeDir, '.config'), 'orca')
}
