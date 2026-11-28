import {
  RUNTIME_SOURCE_ID_ENV,
  RUNTIME_SOURCE_INCARNATION_ENV,
  RUNTIME_SOURCE_PROFILE_PATH_ENV
} from '../../remote-runtime/host-catalog/runtime-source-env'

export function addWslEnvKeys(
  env: Record<string, string | undefined>,
  keys: readonly string[]
): void {
  const existing = env.WSLENV ?? process.env.WSLENV ?? ''
  const tokens = existing.split(':').filter(Boolean)
  const tokenNames = new Set(tokens.map((token) => token.split('/')[0]))

  for (const key of keys) {
    // Compare by name so a flagged key never duplicates or rewrites an existing entry.
    const name = key.split('/')[0]
    if (!tokenNames.has(name)) {
      tokens.push(key)
      tokenNames.add(name)
    }
  }

  env.WSLENV = tokens.join(':')
}

// The runtime-source stamp travels with the handle so a guest CLI on another runtime is fenced off.
const PANE_IDENTITY_WSLENV_KEYS = [
  'ORCA_TERMINAL_HANDLE',
  RUNTIME_SOURCE_ID_ENV,
  RUNTIME_SOURCE_INCARNATION_ENV,
  RUNTIME_SOURCE_PROFILE_PATH_ENV
] as const

/** A Windows shell can spawn WSL tools that inherit only WSLENV-listed variables. */
export function addTerminalHandleToWslEnv(env: Record<string, string | undefined>): void {
  if (!env.ORCA_TERMINAL_HANDLE) {
    return
  }
  addWslEnvKeys(
    env,
    PANE_IDENTITY_WSLENV_KEYS.filter((key) => env[key]).map((key) => `${key}/u`)
  )
}
