import { isWindowsAbsolutePathLike } from './cross-platform-path'
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

function containsShellExpansionSyntax(command: string): boolean {
  return /[$#*?[\]{}\r\n]/.test(command) || /(?:^|\s)['"]~/.test(command) || command.includes('\\~')
}

function containsShellControlSyntax(command: string): boolean {
  let quote: "'" | '"' | null = null
  let escaped = false
  for (const char of command) {
    if (escaped) {
      escaped = false
    } else if (quote === "'") {
      if (char === quote) {
        quote = null
      }
    } else if (char === '\\') {
      escaped = true
    } else if (quote === '"') {
      if (char === quote) {
        quote = null
      } else if (char === '`') {
        return true
      }
    } else if (char === "'" || char === '"') {
      quote = char
    } else if (';&|<>()`'.includes(char)) {
      return true
    }
  }
  return escaped || quote !== null
}

function openSshExecutableEnd(command: string): number | null {
  const match = /^[ \t]*(?:'([^']*)'|"((?:\\.|[^"\\])*)"|([^ \t'"]+))(?=[ \t]|$)/.exec(command)
  const executable = match?.[1] ?? match?.[2] ?? match?.[3] ?? ''
  if (
    !match ||
    (match[3]?.includes('\\') && !isWindowsAbsolutePathLike(executable)) ||
    !isMergeableOpenSshCommand(executable)
  ) {
    return null
  }
  return match[0].length
}

function quoteBareWindowsPathWords(command: string): string {
  return command.replace(
    /'[^']*'|"(?:\\.|[^"\\])*"|(?:\\.|[^ \t'"\\])+/g,
    (word: string, offset: number) => {
      const end = offset + word.length
      const windowsPath = /(?:^|=|^-[A-Za-z])([A-Za-z]:\\|\\\\)/.exec(word)
      if (
        word.startsWith("'") ||
        word.startsWith('"') ||
        (offset > 0 && !/[ \t]/.test(command[offset - 1])) ||
        (end < command.length && !/[ \t]/.test(command[end])) ||
        !windowsPath
      ) {
        return word
      }
      const uncPrefixOffset =
        windowsPath[1] === '\\\\' ? windowsPath.index + windowsPath[0].length - 2 : -1
      return quotePosixShell(
        word.replace(/\\([ \t'"\\;&|<>()`])/g, (match, escaped: string, offset: number) =>
          offset === uncPrefixOffset && word[offset + 2] !== '\\' ? match : escaped
        )
      )
    }
  )
}

function buildOpenSshBatchModeCommand(configuredCommand: string): string | null {
  if (
    containsShellExpansionSyntax(configuredCommand) ||
    containsShellControlSyntax(configuredCommand)
  ) {
    return null
  }
  const command = quoteBareWindowsPathWords(configuredCommand)
  const end = openSshExecutableEnd(command)
  if (end === null) {
    return null
  }
  // OpenSSH keeps the first value; avoid rebuilding the configured argument list.
  return `${command.slice(0, end)} -o BatchMode=yes${command.slice(end)}`
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
