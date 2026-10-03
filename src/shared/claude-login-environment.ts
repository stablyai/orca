import {
  CLAUDE_AUTH_ENV_VARS,
  CLAUDE_AUTH_HEADER_POSIX_PATTERN,
  isAuthLikeClaudeCustomHeaders
} from './claude-auth-env'
import { quotePosixShell } from './wsl-login-shell-command'

/** A host env for running Claude in `configDir`: no inherited credential can override its login.
 *  Strips what a launch strips, so login and launch agree on custom headers. */
export function claudeLoginHostEnv(
  baseEnv: NodeJS.ProcessEnv,
  configDir: string,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(baseEnv)) {
    const normalized = platform === 'win32' ? key.toUpperCase() : key
    const credential =
      CLAUDE_AUTH_ENV_VARS.some((name) => name === normalized) ||
      (normalized === 'ANTHROPIC_CUSTOM_HEADERS' && isAuthLikeClaudeCustomHeaders(value))
    if (!credential) {
      env[key] = value
    }
  }
  // Why both: Claude Code 2.1.220+ hashes CLAUDE_SECURESTORAGE_CONFIG_DIR for the Keychain name.
  return { ...env, CLAUDE_CONFIG_DIR: configDir, CLAUDE_SECURESTORAGE_CONFIG_DIR: configDir }
}

/** The same run inside a WSL guest, as a POSIX script for `/bin/sh -c`. */
export function claudeLoginWslScript(
  linuxConfigDir: string,
  args: readonly string[],
  options: { exec?: boolean } = {}
): string {
  const home = quotePosixShell(linuxConfigDir)
  return [
    `unset ${CLAUDE_AUTH_ENV_VARS.join(' ')}`,
    `case "\${ANTHROPIC_CUSTOM_HEADERS:-}" in ${CLAUDE_AUTH_HEADER_POSIX_PATTERN}) unset ANTHROPIC_CUSTOM_HEADERS ;; esac`,
    `${options.exec ? 'exec ' : ''}env CLAUDE_CONFIG_DIR=${home} CLAUDE_SECURESTORAGE_CONFIG_DIR=${home} claude ${args.map(quotePosixShell).join(' ')}`
  ].join('; ')
}
