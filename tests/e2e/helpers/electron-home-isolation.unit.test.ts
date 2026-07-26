import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  areSameHomePath,
  assertElectronResolvedIsolatedHome,
  createElectronHomeIsolation
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
      codexRealHomeEnabled: false,
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
      ORCA_E2E_USER_DATA_DIR: userDataDir,
      ORCA_CODEX_SYSTEM_DEFAULT_REAL_HOME: '0'
    })
    expect(isolation.env.CODEX_HOME).toBeUndefined()
    expect(isolation.env.ORCA_CODEX_HOME).toBeUndefined()
    expect(isolation.env.ZDOTDIR).toBeUndefined()
  })

  it('rejects generic fixture overlays that could escape the boundary', () => {
    expect(() =>
      createElectronHomeIsolation({
        inheritedEnv: {},
        launchEnv: { CODEX_HOME: '/unsafe' },
        extraEnv: {},
        userDataDir: createUserDataDir(),
        codexRealHomeEnabled: false,
        realHome: '/real/home'
      })
    ).toThrow(/launchEnv\.CODEX_HOME/)

    expect(() =>
      createElectronHomeIsolation({
        inheritedEnv: {},
        launchEnv: {},
        extraEnv: { ORCA_E2E_USER_DATA_DIR: '/unsafe' },
        userDataDir: createUserDataDir(),
        codexRealHomeEnabled: false,
        realHome: '/real/home'
      })
    ).toThrow(/orcaAppExtraEnv\.ORCA_E2E_USER_DATA_DIR/)
  })

  it('keeps real-home routing inside the disposable home when explicitly enabled', () => {
    const isolation = createElectronHomeIsolation({
      inheritedEnv: {},
      launchEnv: {},
      extraEnv: {},
      userDataDir: createUserDataDir(),
      codexRealHomeEnabled: true,
      realHome: '/real/home'
    })

    expect(isolation.env.ORCA_CODEX_SYSTEM_DEFAULT_REAL_HOME).toBe('1')
    expect(() =>
      assertElectronResolvedIsolatedHome(isolation.isolatedHome, isolation)
    ).not.toThrow()
  })

  it('compares Windows home paths case-insensitively', () => {
    expect(areSameHomePath('C:\\Users\\Alice', 'c:\\users\\alice', 'win32')).toBe(true)
  })
})
