import { quotePosixShell } from './wsl-login-shell-command'

export type GitSshPolicyMode =
  | 'default'
  | 'explicit-env'
  | 'fallback'
  | 'configured-openssh'
  | 'configured-wrapper-passthrough'

export const GIT_SSH_CONFIG_ARGS = [
  'config',
  '--null',
  '--get-regexp',
  '^(core\\.sshcommand|ssh\\.variant)$'
]

export function parseGitSshConfig(stdout: string): { command: string; variant?: string } {
  let command = ''
  let variant: string | undefined
  for (const entry of stdout.split('\0')) {
    const separator = entry.indexOf('\n')
    const key = entry.slice(0, separator)
    const value = entry.slice(separator + 1)
    if (key === 'core.sshcommand') {
      command = value
    }
    if (key === 'ssh.variant') {
      variant = value
    }
  }
  return { command, variant }
}

function commandBasename(command: string): string {
  const pieces = command.split(/[\\/]+/)
  return pieces.at(-1)?.toLowerCase() ?? command.toLowerCase()
}

function isMergeableOpenSshCommand(command: string): boolean {
  const basename = commandBasename(command)
  return basename === 'ssh' || basename === 'ssh.exe'
}

function shellTokenize(command: string): string[] | null {
  const tokens: string[] = []
  let current = ''
  let quote: "'" | '"' | null = null
  let escaped = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '\\') {
      const next = command[i + 1]
      if (next && /[\s'"\\]/.test(next)) {
        escaped = true
      } else {
        current += char
      }
      continue
    }
    if (quote) {
      if (char === quote) {
        quote = null
      } else {
        current += char
      }
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    if (';&|<>()`'.includes(char)) {
      return null
    }
    current += char
  }

  if (escaped || quote) {
    return null
  }
  if (current) {
    tokens.push(current)
  }
  return tokens
}

function shellQuoteToken(token: string): string {
  return /^[A-Za-z0-9_@%+=:,./~-]+$/.test(token) ? token : quotePosixShell(token)
}

function containsShellExpansionSyntax(command: string): boolean {
  return /[$#*?[\]{}\r\n]/.test(command) || /(?:^|\s)['"]~/.test(command) || command.includes('\\~')
}

function withoutBatchModeOptions(tokens: string[]): string[] {
  const next: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    const lower = token.toLowerCase()
    if (lower === '-o') {
      const option = tokens[i + 1]?.toLowerCase()
      if (option?.startsWith('batchmode')) {
        i += 1
        continue
      }
    }
    if (lower.startsWith('-obatchmode')) {
      continue
    }
    next.push(token)
  }
  return next
}

function buildOpenSshBatchModeCommand(configuredCommand: string): string | null {
  if (containsShellExpansionSyntax(configuredCommand)) {
    return null
  }
  const tokens = shellTokenize(configuredCommand)
  if (!tokens || tokens.length === 0 || !isMergeableOpenSshCommand(tokens[0])) {
    return null
  }
  return [...withoutBatchModeOptions(tokens), '-o', 'BatchMode=yes'].map(shellQuoteToken).join(' ')
}

export function buildGitSshPolicyEnv(
  env: NodeJS.ProcessEnv,
  configuredCommand: string,
  configuredVariant?: string
): { env: NodeJS.ProcessEnv; mode: GitSshPolicyMode } {
  if (env.GIT_SSH_COMMAND || env.GIT_SSH) {
    return { env, mode: 'explicit-env' }
  }
  if (!configuredCommand) {
    return { env: { ...env, GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' }, mode: 'fallback' }
  }
  const variant = (env.GIT_SSH_VARIANT ?? configuredVariant)?.toLowerCase()
  const batchModeCommand =
    !variant || variant === 'ssh' || variant === 'auto'
      ? buildOpenSshBatchModeCommand(configuredCommand)
      : null
  if (!batchModeCommand) {
    return { env, mode: 'configured-wrapper-passthrough' }
  }
  return {
    env: { ...env, GIT_SSH_COMMAND: batchModeCommand },
    mode: 'configured-openssh'
  }
}
