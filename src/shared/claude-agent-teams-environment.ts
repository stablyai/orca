import { win32 as pathWin32 } from 'node:path'

export const NATIVE_AGENT_TEAMS_ENV_KEYS = [
  'TMUX',
  'TMUX_PANE',
  'ORCA_AGENT_TEAMS_TEAM_ID',
  'ORCA_AGENT_TEAMS_TOKEN',
  'ORCA_AGENT_TEAMS_LEADER_PANE',
  'ORCA_AGENT_TEAMS_SHIM_DIR',
  'ORCA_AGENT_TEAMS_SHIM_BIN',
  'ORCA_AGENT_TEAMS_SHIM_EXECUTABLE',
  'ORCA_AGENT_TEAMS_SHIM_CLI_ENTRY'
] as const

function normalizeWindowsPathEntry(value: string): string {
  return pathWin32
    .normalize(value.trim().replace(/^"|"$/g, ''))
    .replace(/[\\]+$/, '')
    .toLowerCase()
}

export function stripNativeAgentTeamsEnv(
  env: Record<string, string>,
  platform: NodeJS.Platform
): Record<string, string> {
  const stripped = { ...env }
  const windows = platform === 'win32'
  const shimDirs = new Set(
    (windows
      ? Object.keys(stripped)
          .filter((key) => key.toLowerCase() === 'orca_agent_teams_shim_dir')
          .map((key) => stripped[key])
      : [stripped.ORCA_AGENT_TEAMS_SHIM_DIR]
    )
      .filter((value): value is string => Boolean(value))
      .map((value) => (windows ? normalizeWindowsPathEntry(value) : value))
  )
  const pathKeys =
    platform === 'win32'
      ? Object.keys(stripped).filter((key) => key.toLowerCase() === 'path')
      : ['PATH']
  for (const pathKey of pathKeys) {
    if (shimDirs.size > 0 && stripped[pathKey]) {
      stripped[pathKey] = stripped[pathKey]
        .split(platform === 'win32' ? ';' : ':')
        .filter((entry) =>
          windows ? !shimDirs.has(normalizeWindowsPathEntry(entry)) : !shimDirs.has(entry)
        )
        .join(platform === 'win32' ? ';' : ':')
    }
  }
  const nativeKeys = new Set(
    windows
      ? NATIVE_AGENT_TEAMS_ENV_KEYS.map((key) => key.toLowerCase())
      : NATIVE_AGENT_TEAMS_ENV_KEYS
  )
  for (const key of Object.keys(stripped)) {
    if (nativeKeys.has(windows ? key.toLowerCase() : key)) {
      delete stripped[key]
    }
  }
  return stripped
}
