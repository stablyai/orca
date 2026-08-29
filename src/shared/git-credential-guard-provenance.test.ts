import { describe, expect, it } from 'vitest'
import {
  restoreGitCredentialGuardEnv,
  takeGitCredentialGuardEnv
} from './git-credential-guard-env-test-harness'
import { gitCredentialPromptGuardEnv } from './git-credential-prompt-env'
import {
  captureGitCredentialGuardPreGuardState,
  recordGitCredentialGuardProvenance,
  restoreUnguardedGitCredentialEnv,
  TERMINAL_GIT_CREDENTIAL_GUARD_RESTORE_ENV as MARKER
} from './git-credential-guard-provenance'

/** An env carrying the guard, marked with the provenance `raw` describes. */
function guardedEnv(raw: string): Record<string, string> {
  return {
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.interactive',
    GIT_CONFIG_VALUE_0: 'false',
    GIT_CONFIG_KEY_1: 'credential.guiPrompt',
    GIT_CONFIG_VALUE_1: 'false',
    [MARKER]: raw
  }
}

const INTACT_GUARD = {
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'credential.interactive',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'credential.guiPrompt',
  GIT_CONFIG_VALUE_1: 'false'
}

describe('restoreUnguardedGitCredentialEnv marker handling', () => {
  it('leaves everything alone when there is no marker at all', () => {
    const env = { ...INTACT_GUARD }
    expect(restoreUnguardedGitCredentialEnv(env)).toBe(false)
    expect(env).toEqual(INTACT_GUARD)
  })

  // A marker Orca cannot read cannot tell it which values are Orca's, so the
  // arm it falls to must be "change nothing" — never "clear the user's Git env".
  it.each([
    ['truncated json', '{"v":1,"env":{"GIT_TERMINAL_PROM'],
    ['not json at all', 'guard'],
    ['a json non-object', '"guard"'],
    ['a future marker version', '{"v":2,"env":{"GIT_TERMINAL_PROMPT":"1"},"configBase":0}'],
    ['a missing version', '{"env":{"GIT_TERMINAL_PROMPT":"1"},"configBase":0}'],
    ['a non-object env', '{"v":1,"env":"GIT_TERMINAL_PROMPT","configBase":0}']
  ])('leaves the guard intact for %s', (_label, raw) => {
    const env = guardedEnv(raw)
    expect(restoreUnguardedGitCredentialEnv(env)).toBe(false)
    expect(env).toEqual(INTACT_GUARD)
  })

  it('drops an unreadable marker so it cannot be mistaken for provenance later', () => {
    const env = guardedEnv('{"v":1,"env":{')
    restoreUnguardedGitCredentialEnv(env)
    expect(Object.hasOwn(env, MARKER)).toBe(false)
  })

  it('ignores a marker whose recorded values are not strings or null', () => {
    const env = guardedEnv(
      '{"v":1,"env":{"GIT_TERMINAL_PROMPT":7,"GCM_INTERACTIVE":null},"configBase":null}'
    )
    expect(restoreUnguardedGitCredentialEnv(env)).toBe(true)
    // 7 is not a recorded value, so the key is not Orca's to restore.
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.GCM_INTERACTIVE).toBeUndefined()
  })

  it('ignores a configBase that is not a safe integer', () => {
    for (const base of ['"0"', '0.5', '1e400', 'true']) {
      const env = guardedEnv(`{"v":1,"env":{},"configBase":${base}}`)
      restoreUnguardedGitCredentialEnv(env)
      expect(env.GIT_CONFIG_COUNT).toBe('2')
      expect(env.GIT_CONFIG_KEY_0).toBe('credential.interactive')
    }
  })

  // A negative base is not a position the guard can ever have appended at, but it
  // still satisfies Number.isSafeInteger. Left unvalidated it makes index 0 look
  // guard-owned and deletes a pair the user configured themselves.
  it('ignores a negative configBase instead of treating index 0 as a guard slot', () => {
    const env = guardedEnv('{"v":1,"env":{},"configBase":-1}')
    restoreUnguardedGitCredentialEnv(env)
    expect(env.GIT_CONFIG_COUNT).toBe('2')
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.interactive')
    expect(env.GIT_CONFIG_VALUE_0).toBe('false')
    expect(env.GIT_CONFIG_KEY_1).toBe('credential.guiPrompt')
  })

  // The guard forwards only its scalars and the indexed-config protocol into
  // WSLENV -- never the askpass names. Removing a name the guard never added
  // strips the user's own WSL forwarding, which is the leak's mirror image.
  it('keeps a WSLENV name the guard never forwards, even when it appeared after the guard', () => {
    const saved = takeGitCredentialGuardEnv()
    try {
      const env: Record<string, string> = { WSLENV: 'MY_VAR/u' }
      const pre = captureGitCredentialGuardPreGuardState(env)
      Object.assign(env, gitCredentialPromptGuardEnv(env, 'win32') as Record<string, string>)
      recordGitCredentialGuardProvenance(env, pre, { appendedConfig: true, forwardToWsl: true })
      // The user forwards their own askpass into WSL from inside the guarded pane.
      env.WSLENV = `${env.WSLENV}:GIT_ASKPASS/p`

      expect(restoreUnguardedGitCredentialEnv(env)).toBe(true)
      expect(env.WSLENV).toBe('MY_VAR/u:GIT_ASKPASS/p')
    } finally {
      restoreGitCredentialGuardEnv(saved)
    }
  })

  // A marker that names no config base did not append config, so nothing indexed
  // in this environment is Orca's — including a pair that looks exactly like ours.
  it('never removes indexed config when the marker claims no config base', () => {
    const env = guardedEnv('{"v":1,"env":{"GIT_TERMINAL_PROMPT":null},"configBase":null}')
    expect(restoreUnguardedGitCredentialEnv(env)).toBe(true)
    expect(env.GIT_TERMINAL_PROMPT).toBeUndefined()
    expect(env.GIT_CONFIG_COUNT).toBe('2')
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.interactive')
    expect(env.GIT_CONFIG_VALUE_0).toBe('false')
    expect(env.GIT_CONFIG_KEY_1).toBe('credential.guiPrompt')
  })

  it('round-trips a capture through a record and back to the captured values', () => {
    const original = {
      GIT_TERMINAL_PROMPT: '1',
      GIT_ASKPASS: '/usr/local/bin/ask',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.proxy',
      GIT_CONFIG_VALUE_0: 'http://proxy.invalid'
    }
    const env: Record<string, string> = { ...original }
    const pre = captureGitCredentialGuardPreGuardState(env)
    Object.assign(env, {
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      SSH_ASKPASS: '',
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_1: 'credential.interactive',
      GIT_CONFIG_VALUE_1: 'false',
      GIT_CONFIG_KEY_2: 'credential.guiPrompt',
      GIT_CONFIG_VALUE_2: 'false'
    })
    recordGitCredentialGuardProvenance(env, pre, { appendedConfig: true, forwardToWsl: false })

    expect(restoreUnguardedGitCredentialEnv(env)).toBe(true)
    expect(env).toEqual(original)
  })
  // The coupling ratchet. `guardOwnedValue` and SCALAR_KEYS mirror, by hand and in
  // another file, what gitCredentialPromptGuardEnv writes. Nothing else enforces
  // that: a guard key this module does not know is simply left in the child, which
  // is the leak. Asserting guard-then-restore is the identity catches both a value
  // that drifts and a key that is added.
  it.each(['linux', 'darwin', 'win32'] as const)(
    'undoes every key the real guard writes on %s',
    (platform) => {
      const saved = takeGitCredentialGuardEnv()
      try {
        const original = { PATH: '/usr/bin', HOME: '/home/u' }
        const env: Record<string, string> = { ...original }
        const pre = captureGitCredentialGuardPreGuardState(env)
        const guarded = gitCredentialPromptGuardEnv(env, platform) as Record<string, string>
        // Liveness: without this the marker alone would satisfy the round trip and
        // a guard that stopped writing anything would still pass.
        const touched = Object.keys(guarded).filter((key) => guarded[key] !== env[key])
        expect(touched.length).toBeGreaterThan(0)
        Object.assign(env, guarded)
        recordGitCredentialGuardProvenance(env, pre, {
          appendedConfig: true,
          forwardToWsl: platform === 'win32'
        })

        expect(restoreUnguardedGitCredentialEnv(env)).toBe(true)
        expect(env).toEqual(original)
      } finally {
        restoreGitCredentialGuardEnv(saved)
      }
    }
  )
})
