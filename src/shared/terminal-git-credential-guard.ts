import { recognizeAgentProcessFromCommandLine } from './agent-process-recognition'
import {
  captureGitCredentialGuardPreGuardState,
  recordGitCredentialGuardProvenance,
  restoreUnguardedGitCredentialEnv
} from './git-credential-guard-provenance'
import { gitCredentialPromptGuardEnv } from './git-credential-prompt-env'

const GIT_CONFIG_PROTOCOL_KEY_RE = /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/

export const TERMINAL_GIT_CREDENTIAL_GUARD_POLICY_ENV =
  'ORCA_INTERNAL_TERMINAL_GIT_CREDENTIAL_GUARD_POLICY'

/** Disable credential UI only for recognized agents and marked automation. */
export function applyTerminalGitCredentialPromptGuard(
  env: Record<string, string>,
  opts: {
    launchCommand?: string | null
    isUnattended?: boolean
    platform?: NodeJS.Platform
    /** A detached host appends indexed config after its authoritative env merge. */
    deferGitConfigGuardToHost?: boolean
  }
): boolean {
  const explicitlyGuarded = env[TERMINAL_GIT_CREDENTIAL_GUARD_POLICY_ENV] === 'guard'
  delete env[TERMINAL_GIT_CREDENTIAL_GUARD_POLICY_ENV]

  // Why: guard variables are inherited by every child, so undo an inherited Orca
  // guard before deciding afresh. Otherwise a terminal this call declines to guard
  // keeps the parent's GIT_TERMINAL_PROMPT=0 and Git fails instead of prompting.
  restoreUnguardedGitCredentialEnv(env)
  const platform = opts.platform ?? process.platform

  const shouldGuard =
    opts.isUnattended === true ||
    Boolean(
      recognizeAgentProcessFromCommandLine(opts.launchCommand, { includeHeadlessOneShot: true })
    )
  if (!explicitlyGuarded && !shouldGuard) {
    return false
  }

  const preGuard = captureGitCredentialGuardPreGuardState(env)
  const guarded = gitCredentialPromptGuardEnv(env, platform)
  if (!opts.deferGitConfigGuardToHost) {
    Object.assign(env, guarded)
    recordGitCredentialGuardProvenance(env, preGuard, {
      appendedConfig: true,
      forwardToWsl: platform === 'win32'
    })
    return true
  }

  // Why: the daemon must append indexed config after merging its own inherited
  // environment; the sparse wire carries only the guard decision and scalars.
  env[TERMINAL_GIT_CREDENTIAL_GUARD_POLICY_ENV] = 'guard'
  for (const [key, value] of Object.entries(guarded)) {
    if (typeof value !== 'string' || GIT_CONFIG_PROTOCOL_KEY_RE.test(key)) {
      continue
    }
    if (key === 'WSLENV') {
      continue
    }
    if ((key === 'GIT_ASKPASS' || key === 'SSH_ASKPASS') && !Object.hasOwn(env, key)) {
      continue
    }
    env[key] = value
  }
  recordGitCredentialGuardProvenance(env, preGuard, {
    appendedConfig: false,
    forwardToWsl: false
  })
  return true
}
