import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  areSameHomePath,
  assertElectronResolvedIsolatedHome,
  createElectronHomeIsolation,
  HERMETIC_SHELL_ENV
} from './electron-home-isolation'

const tempDirs: string[] = []

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

function createUserDataDir(): string {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'orca-home-isolation-test-'))
  tempDirs.push(tempDir)
  return tempDir
}

describe('createElectronHomeIsolation', () => {
  it('strips ambient home and Codex state before forcing a disposable home', () => {
    const userDataDir = createUserDataDir()
    const isolation = createElectronHomeIsolation({
      inheritedEnv: {
        HOME: '/real/home',
        USERPROFILE: '/real/home',
        CODEX_HOME: '/real/codex',
        ORCA_CODEX_HOME: '/real/orca-codex',
        ZDOTDIR: '/real/zdotdir',
        PATH: '/bin'
      },
      launchEnv: { TEST_TOKEN: 'safe' },
      extraEnv: { EXTRA_TEST_FLAG: '1' },
      userDataDir,
      realHome: '/real/home'
    })

    // Why: the disposable home must be the canonical spelling (no tmpdir
    // symlink/8.3 alias) or git-canonicalized worktree paths stop matching.
    const canonicalHome = realpathSync.native(path.join(userDataDir, 'home'))
    expect(isolation.isolatedHome).toBe(canonicalHome)
    expect(isolation.env).toMatchObject({
      PATH: '/bin',
      TEST_TOKEN: 'safe',
      EXTRA_TEST_FLAG: '1',
      HOME: canonicalHome,
      USERPROFILE: canonicalHome,
      ORCA_E2E_USER_DATA_DIR: userDataDir
    })
    expect(isolation.env.CODEX_HOME).toBeUndefined()
    expect(isolation.env.ORCA_CODEX_HOME).toBeUndefined()
    expect(isolation.env.ZDOTDIR).toBeUndefined()
    // Codex always routes to the resolved home, so the post-launch guard must
    // accept the boundary this env produces.
    expect(() =>
      assertElectronResolvedIsolatedHome(isolation.isolatedHome, isolation)
    ).not.toThrow()
  })

  it('rejects generic fixture overlays that could escape the boundary', () => {
    expect(() =>
      createElectronHomeIsolation({
        inheritedEnv: {},
        launchEnv: { CODEX_HOME: '/unsafe' },
        extraEnv: {},
        userDataDir: createUserDataDir(),
        realHome: '/real/home'
      })
    ).toThrow(/launchEnv\.CODEX_HOME/)

    expect(() =>
      createElectronHomeIsolation({
        inheritedEnv: {},
        launchEnv: {},
        extraEnv: { ORCA_E2E_USER_DATA_DIR: '/unsafe' },
        userDataDir: createUserDataDir(),
        realHome: '/real/home'
      })
    ).toThrow(/orcaAppExtraEnv\.ORCA_E2E_USER_DATA_DIR/)
  })

  it('keeps the inherited shell without the hermetic overlay', () => {
    const plainHome = createElectronHomeIsolation({
      inheritedEnv: { SHELL: '/opt/homebrew/bin/fish' },
      launchEnv: {},
      extraEnv: {},
      userDataDir: createUserDataDir(),
      realHome: '/real/home'
    })
    expect(plainHome.env.SHELL).toBe('/opt/homebrew/bin/fish')
    expect(plainHome.env.ZDOTDIR).toBeUndefined()
    expect(readdirSync(plainHome.isolatedHome)).toEqual([])
  })

  it.each([
    ['launchEnv', { launchEnv: HERMETIC_SHELL_ENV, extraEnv: {} }],
    ['extraEnv', { launchEnv: {}, extraEnv: HERMETIC_SHELL_ENV }]
  ])('pins a prompt-neutral shell when %s carries the hermetic overlay', (_name, overlays) => {
    const hermetic = createElectronHomeIsolation({
      inheritedEnv: { SHELL: '/opt/homebrew/bin/fish', ZDOTDIR: '/real/zdotdir' },
      ...overlays,
      userDataDir: createUserDataDir(),
      realHome: '/real/home'
    })
    expect(hermetic.env.SHELL).toBe(process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
    expect(hermetic.env.ZDOTDIR).toBe(hermetic.isolatedHome)
    expect(readFileSync(path.join(hermetic.isolatedHome, '.zshrc'), 'utf8')).toBe(
      "PROMPT='%# '\nRPROMPT=''\n"
    )
    expect(readFileSync(path.join(hermetic.isolatedHome, '.bash_profile'), 'utf8')).toBe(
      "PS1='\\$ '\n"
    )
  })

  it('compares Windows home paths case-insensitively', () => {
    expect(areSameHomePath('C:\\Users\\Alice', 'c:\\users\\alice', 'win32')).toBe(true)
  })
})
