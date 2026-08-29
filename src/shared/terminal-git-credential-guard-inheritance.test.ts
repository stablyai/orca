import { describe, expect, it } from 'vitest'
import {
  restoreGitCredentialGuardEnv,
  takeGitCredentialGuardEnv
} from './git-credential-guard-env-test-harness'
import { TERMINAL_GIT_CREDENTIAL_GUARD_RESTORE_ENV } from './git-credential-guard-provenance'
import {
  applyTerminalGitCredentialPromptGuard,
  TERMINAL_GIT_CREDENTIAL_GUARD_POLICY_ENV
} from './terminal-git-credential-guard'

/** Env a guarded agent pane exports to everything it launches. */
function guardedParentEnv(
  platform: NodeJS.Platform,
  seed: Record<string, string> = {}
): Record<string, string> {
  const env: Record<string, string> = { PATH: '/usr/bin', ...seed }
  expect(applyTerminalGitCredentialPromptGuard(env, { launchCommand: 'claude', platform })).toBe(
    true
  )
  return env
}

function spawnChild(
  parentEnv: Record<string, string>,
  opts: Parameters<typeof applyTerminalGitCredentialPromptGuard>[1]
): { env: Record<string, string>; guarded: boolean } {
  const env = { ...parentEnv }
  return { env, guarded: applyTerminalGitCredentialPromptGuard(env, opts) }
}

describe('guard env inherited by a terminal the guard declines to guard', () => {
  it('does not leave GIT_TERMINAL_PROMPT=0 in an ordinary user terminal', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const { env, guarded } = spawnChild(guardedParentEnv(platform), {
        launchCommand: '/bin/zsh',
        platform
      })

      expect(guarded).toBe(false)
      expect(env.GIT_TERMINAL_PROMPT).toBeUndefined()
      expect(env.GCM_INTERACTIVE).toBeUndefined()
      expect(env.GIT_ASKPASS).toBeUndefined()
      expect(env.SSH_ASKPASS).toBeUndefined()
    }
  })

  it('removes the whole indexed Git config protocol coherently', () => {
    const { env } = spawnChild(guardedParentEnv('linux'), {
      launchCommand: '/bin/zsh',
      platform: 'linux'
    })

    expect(env.GIT_CONFIG_COUNT).toBeUndefined()
    expect(Object.keys(env).filter((key) => key.startsWith('GIT_CONFIG_'))).toEqual([])
  })

  it('keeps a caller indexed config entry the guard appended after', () => {
    const parent = guardedParentEnv('linux', {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.proxy',
      GIT_CONFIG_VALUE_0: 'http://proxy.invalid'
    })
    expect(parent.GIT_CONFIG_COUNT).toBe('3')

    const { env } = spawnChild(parent, { launchCommand: '/bin/zsh', platform: 'linux' })

    expect(env.GIT_CONFIG_COUNT).toBe('1')
    expect(env.GIT_CONFIG_KEY_0).toBe('http.proxy')
    expect(env.GIT_CONFIG_VALUE_0).toBe('http://proxy.invalid')
    expect(env.GIT_CONFIG_KEY_1).toBeUndefined()
    expect(env.GIT_CONFIG_VALUE_1).toBeUndefined()
  })

  it('keeps indexed config entries appended after the guard, identical-looking or not', () => {
    const parent = guardedParentEnv('linux', {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.proxy',
      GIT_CONFIG_VALUE_0: 'http://proxy.invalid'
    })
    expect(parent.GIT_CONFIG_COUNT).toBe('3')
    // Hardening the user appended inside the guarded pane, after Orca's own pair.
    Object.assign(parent, {
      GIT_CONFIG_KEY_3: 'credential.interactive',
      GIT_CONFIG_VALUE_3: 'false',
      GIT_CONFIG_KEY_4: 'credential.guiPrompt',
      GIT_CONFIG_VALUE_4: 'false',
      GIT_CONFIG_COUNT: '5'
    })

    const { env } = spawnChild(parent, { launchCommand: '/bin/zsh', platform: 'linux' })

    expect(env.GIT_CONFIG_COUNT).toBe('3')
    expect(env.GIT_CONFIG_KEY_0).toBe('http.proxy')
    expect(env.GIT_CONFIG_VALUE_0).toBe('http://proxy.invalid')
    expect(env.GIT_CONFIG_KEY_1).toBe('credential.interactive')
    expect(env.GIT_CONFIG_VALUE_1).toBe('false')
    expect(env.GIT_CONFIG_KEY_2).toBe('credential.guiPrompt')
    expect(env.GIT_CONFIG_VALUE_2).toBe('false')
    expect(env.GIT_CONFIG_KEY_3).toBeUndefined()
    expect(env.GIT_CONFIG_VALUE_3).toBeUndefined()
  })

  it('restores the user values the guard overwrote', () => {
    const parent = guardedParentEnv('linux', {
      GIT_TERMINAL_PROMPT: '1',
      GCM_INTERACTIVE: 'auto',
      GIT_ASKPASS: '/usr/local/bin/user-askpass'
    })

    const { env } = spawnChild(parent, { launchCommand: '/bin/zsh', platform: 'linux' })

    expect(env.GIT_TERMINAL_PROMPT).toBe('1')
    expect(env.GCM_INTERACTIVE).toBe('auto')
    expect(env.GIT_ASKPASS).toBe('/usr/local/bin/user-askpass')
  })

  it('unwinds only the WSLENV tokens the guard added', () => {
    const parent = guardedParentEnv('win32', { WSLENV: 'CALLER_VALUE/p' })
    expect((parent.WSLENV ?? '').split(':')).toContain('GIT_TERMINAL_PROMPT')

    const { env } = spawnChild(parent, { launchCommand: '/bin/zsh', platform: 'win32' })

    expect(env.WSLENV).toBe('CALLER_VALUE/p')
  })

  it('leaves a guarded child fully guarded', () => {
    const { env, guarded } = spawnChild(guardedParentEnv('linux'), {
      launchCommand: 'claude',
      platform: 'linux'
    })

    expect(guarded).toBe(true)
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.GCM_INTERACTIVE).toBe('never')
    expect(env.GIT_CONFIG_COUNT).toBe('2')
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.interactive')
    expect(env.GIT_CONFIG_KEY_1).toBe('credential.guiPrompt')
  })

  it('leaves a user terminal with no inherited guard untouched', () => {
    const original = {
      PATH: '/usr/bin',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '/usr/local/bin/user-askpass',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.interactive',
      GIT_CONFIG_VALUE_0: 'false'
    }
    const env = { ...original }

    expect(
      applyTerminalGitCredentialPromptGuard(env, {
        launchCommand: '/bin/zsh',
        platform: 'linux'
      })
    ).toBe(false)
    expect(env).toEqual(original)
  })
  it('forwards the provenance marker into WSL beside the guard variables it explains', () => {
    const names = (guardedParentEnv('win32').WSLENV ?? '')
      .split(':')
      .map((token) => token.split('/')[0])

    expect(names).toContain('GIT_TERMINAL_PROMPT')
    expect(names).toContain(TERMINAL_GIT_CREDENTIAL_GUARD_RESTORE_ENV)
  })

  it('carries provenance across a detached-host wire', () => {
    const wire: Record<string, string> = { PATH: '/usr/bin', GIT_TERMINAL_PROMPT: '1' }
    expect(
      applyTerminalGitCredentialPromptGuard(wire, {
        launchCommand: 'claude',
        platform: 'linux',
        deferGitConfigGuardToHost: true
      })
    ).toBe(true)
    expect(wire.GIT_TERMINAL_PROMPT).toBe('0')

    const child = { ...wire }
    // The host consumes the policy marker before the shell ever sees it.
    delete child[TERMINAL_GIT_CREDENTIAL_GUARD_POLICY_ENV]

    expect(
      applyTerminalGitCredentialPromptGuard(child, {
        launchCommand: '/bin/zsh',
        platform: 'linux'
      })
    ).toBe(false)
    expect(child.GIT_TERMINAL_PROMPT).toBe('1')
    expect(child[TERMINAL_GIT_CREDENTIAL_GUARD_RESTORE_ENV]).toBeUndefined()
  })

  it('leaves an indexed config protocol that turned ambiguous fully intact', () => {
    const parent = guardedParentEnv('linux')
    // Something after the guard corrupted the positional protocol.
    parent.GIT_CONFIG_COUNT = '5'

    const { env } = spawnChild(parent, { launchCommand: '/bin/zsh', platform: 'linux' })

    expect(env.GIT_CONFIG_COUNT).toBe('5')
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.interactive')
    expect(env.GIT_CONFIG_VALUE_0).toBe('false')
    expect(env.GIT_CONFIG_KEY_1).toBe('credential.guiPrompt')
    expect(env.GIT_CONFIG_VALUE_1).toBe('false')
  })

  it('does not grow the config protocol as guarded panes nest', () => {
    let env = guardedParentEnv('linux')
    for (let depth = 0; depth < 3; depth++) {
      const next = { ...env }
      expect(
        applyTerminalGitCredentialPromptGuard(next, { launchCommand: 'claude', platform: 'linux' })
      ).toBe(true)
      env = next
    }

    expect(env.GIT_CONFIG_COUNT).toBe('2')
  })
  it('keeps a guard variable the pane itself re-exported', () => {
    const parent = guardedParentEnv('linux')
    // The pane's own shell rc re-enabled prompting after Orca guarded the pane.
    parent.GIT_TERMINAL_PROMPT = '1'
    parent.GCM_INTERACTIVE = 'auto'

    const { env } = spawnChild(parent, { launchCommand: '/bin/zsh', platform: 'linux' })

    expect(env.GIT_TERMINAL_PROMPT).toBe('1')
    expect(env.GCM_INTERACTIVE).toBe('auto')
  })

  it('keeps a guard config slot whose value the pane overrode', () => {
    const parent = guardedParentEnv('linux')
    // Someone inside the pane flipped Orca's own entry back on.
    parent.GIT_CONFIG_VALUE_0 = 'true'

    const { env } = spawnChild(parent, { launchCommand: '/bin/zsh', platform: 'linux' })

    expect(env.GIT_CONFIG_COUNT).toBe('1')
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.interactive')
    expect(env.GIT_CONFIG_VALUE_0).toBe('true')
  })

  it("keeps the caller's own WSLENV token for a guard variable, flags and all", () => {
    const saved = takeGitCredentialGuardEnv()
    try {
      const parent = guardedParentEnv('win32', { WSLENV: 'GIT_ASKPASS/p' })

      const { env } = spawnChild(parent, { launchCommand: '/bin/zsh', platform: 'win32' })

      expect(env.WSLENV).toBe('GIT_ASKPASS/p')
    } finally {
      restoreGitCredentialGuardEnv(saved)
    }
  })

  it('removes WSLENV rather than leaving an empty one behind', () => {
    const saved = takeGitCredentialGuardEnv()
    try {
      const parent = guardedParentEnv('win32')
      expect(parent.WSLENV).toBeTruthy()

      const { env } = spawnChild(parent, { launchCommand: '/bin/zsh', platform: 'win32' })

      expect(Object.hasOwn(env, 'WSLENV')).toBe(false)
    } finally {
      restoreGitCredentialGuardEnv(saved)
    }
  })

  it('never lets a detached-host marker remove indexed config the host owns', () => {
    const wire: Record<string, string> = { PATH: '/usr/bin' }
    expect(
      applyTerminalGitCredentialPromptGuard(wire, {
        launchCommand: 'claude',
        platform: 'linux',
        deferGitConfigGuardToHost: true
      })
    ).toBe(true)

    // The host's own environment already hardens Git the same way Orca does.
    const host: Record<string, string> = {
      ...wire,
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'credential.interactive',
      GIT_CONFIG_VALUE_0: 'false',
      GIT_CONFIG_KEY_1: 'credential.guiPrompt',
      GIT_CONFIG_VALUE_1: 'false'
    }
    delete host[TERMINAL_GIT_CREDENTIAL_GUARD_POLICY_ENV]

    expect(
      applyTerminalGitCredentialPromptGuard(host, {
        launchCommand: '/bin/zsh',
        platform: 'linux'
      })
    ).toBe(false)
    expect(host.GIT_CONFIG_COUNT).toBe('2')
    expect(host.GIT_CONFIG_KEY_0).toBe('credential.interactive')
    expect(host.GIT_CONFIG_VALUE_0).toBe('false')
    expect(host.GIT_CONFIG_KEY_1).toBe('credential.guiPrompt')
  })
})
