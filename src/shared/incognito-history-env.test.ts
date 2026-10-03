import { describe, expect, it } from 'vitest'
import { applyIncognitoHistoryEnv, INCOGNITO_HISTORY_WSLENV_KEYS } from './incognito-history-env'

// Behavioral coverage for the single incognito history-suppression contract shared by the local
// daemon (`withHistoryIsolation`) and the SSH relay (`applyRelayIncognitoEnv`). Asserting the
// resulting env — not the source text — so the two transports provably cannot drift.
describe('applyIncognitoHistoryEnv', () => {
  it('turns off history for every shell Orca supports (bash/zsh-linux/zsh-macOS/fish)', () => {
    const env: Record<string, string> = {}
    applyIncognitoHistoryEnv(env)

    // bash + zsh on Linux honour this directly.
    expect(env.HISTFILE).toBe('/dev/null')
    expect(env.HISTSIZE).toBe('0')
    // zsh on macOS: /etc/zshrc clobbers HISTFILE after this env is applied; the wrapper restores it
    // from ORCA_HISTFILE (which also SELECTS the wrapper), so this pins history off there too.
    expect(env.ORCA_HISTFILE).toBe('/dev/null')
    // fish ignores HISTFILE and keys off its own store; private mode is the equivalent of --private.
    expect(env.fish_private_mode).toBe('1')
    // The inner program can detect it is running private.
    expect(env.ORCA_INCOGNITO).toBe('1')
  })

  it('overwrites an inherited scoped HISTFILE/ORCA_HISTFILE rather than honouring it', () => {
    const env: Record<string, string> = {
      HISTFILE: '/home/u/.orca/history/abc/zsh_history',
      ORCA_HISTFILE: '/home/u/.orca/history/abc/zsh_history'
    }
    applyIncognitoHistoryEnv(env)
    expect(env.HISTFILE).toBe('/dev/null')
    expect(env.ORCA_HISTFILE).toBe('/dev/null')
  })

  it('names every suppression knob as a WSLENV carrier so a WSL guest inherits them', () => {
    // WSL guests only receive host env listed in WSLENV. Every key applyIncognitoHistoryEnv sets must
    // be carried, or incognito is a false promise inside the distro.
    const env: Record<string, string> = {}
    applyIncognitoHistoryEnv(env)
    for (const key of Object.keys(env)) {
      expect(INCOGNITO_HISTORY_WSLENV_KEYS).toContain(key)
    }
    expect([...INCOGNITO_HISTORY_WSLENV_KEYS].sort()).toEqual(
      ['HISTFILE', 'HISTSIZE', 'ORCA_HISTFILE', 'ORCA_INCOGNITO', 'fish_private_mode'].sort()
    )
  })
})
