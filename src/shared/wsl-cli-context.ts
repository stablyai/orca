import { posix } from 'node:path'

export const WSL_CLI_CONTEXT_ENV = 'ORCA_CLI_WSL_CONTEXT'
export const WSL_CLI_ROOT_ENV_KEYS = [
  'CLAUDE_CONFIG_DIR',
  'ORCA_CLAUDE_INJECTED_CONFIG_DIR',
  'ORCA_CLAUDE_USER_CONFIG_DIR',
  'ORCA_CLAUDE_PROFILE_POINTER'
] as const

export type WslCliContext = {
  user: string
  home: string
  cwd: string
  env: NodeJS.ProcessEnv
}

/** Fixed NUL-delimited fields preserve absent, empty and literal values without a guest Node dependency. */
export function readWslCliContext(raw: string): WslCliContext {
  if (raw.length > 64 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    throw new Error('Invalid WSL CLI invocation context')
  }
  const fields = Buffer.from(raw, 'base64').toString('utf8').split('\0')
  const [version, user, home, cwd] = fields
  if (
    fields.length !== 13 ||
    fields[12] !== '' ||
    version !== '1' ||
    !user ||
    user.startsWith('-') ||
    /[\s\0]/.test(user) ||
    !posix.isAbsolute(home) ||
    !posix.isAbsolute(cwd)
  ) {
    throw new Error('Invalid WSL CLI invocation context')
  }
  const env: NodeJS.ProcessEnv = { HOME: home }
  WSL_CLI_ROOT_ENV_KEYS.forEach((key, index) => {
    const present = fields[4 + index * 2]
    if (present !== '' && present !== '1') {
      throw new Error('Invalid WSL CLI invocation context')
    }
    if (present === '1') {
      env[key] = fields[5 + index * 2]
    }
  })
  return { user, home, cwd, env }
}
