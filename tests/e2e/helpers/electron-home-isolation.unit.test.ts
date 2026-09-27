import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  areSameHomePath,
  assertElectronResolvedIsolatedHome,
  createElectronHomeIsolation,
  HERMETIC_SHELL_ENV,
  hermeticProfileSettings,
  resolveE2EFixtureTmpdir
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
    ['launchEnv', 'darwin', { launchEnv: HERMETIC_SHELL_ENV, extraEnv: {} }, '/bin/zsh'],
    ['extraEnv', 'darwin', { launchEnv: {}, extraEnv: HERMETIC_SHELL_ENV }, '/bin/zsh'],
    ['extraEnv', 'linux', { launchEnv: {}, extraEnv: HERMETIC_SHELL_ENV }, '/bin/bash']
  ] as const)(
    'pins a prompt-neutral shell when %s carries the hermetic overlay on %s',
    (_name, platform, overlays, shell) => {
      const hermetic = createElectronHomeIsolation({
        inheritedEnv: { SHELL: '/opt/homebrew/bin/fish', ZDOTDIR: '/real/zdotdir' },
        ...overlays,
        userDataDir: createUserDataDir(),
        realHome: '/real/home',
        platform
      })
      expect(hermetic.env.SHELL).toBe(shell)
      expect(hermetic.env.ZDOTDIR).toBe(hermetic.isolatedHome)
      expect(hermetic.env.PROMPT).toBeUndefined()
      expect(readFileSync(path.join(hermetic.isolatedHome, '.zshrc'), 'utf8')).toBe(
        "PROMPT='%# '\nRPROMPT=''\n"
      )
      expect(readFileSync(path.join(hermetic.isolatedHome, '.bash_profile'), 'utf8')).toBe(
        "PS1='\\$ '\n"
      )
    }
  )

  it('gives Windows cmd.exe a bare prompt instead of POSIX rc files', () => {
    const hermetic = createElectronHomeIsolation({
      inheritedEnv: { SHELL: '/usr/bin/bash', PROMPT: '$P$G' },
      launchEnv: {},
      extraEnv: HERMETIC_SHELL_ENV,
      userDataDir: createUserDataDir(),
      realHome: '/real/home',
      platform: 'win32'
    })
    expect(hermetic.env.PROMPT).toBe('$G$S')
    expect(hermetic.env.SHELL).toBe('/usr/bin/bash')
    expect(hermetic.env.ZDOTDIR).toBeUndefined()
    expect(readdirSync(hermetic.isolatedHome)).toEqual([])
  })

  it('compares Windows home paths case-insensitively', () => {
    expect(areSameHomePath('C:\\Users\\Alice', 'c:\\users\\alice', 'win32')).toBe(true)
  })
})

describe('hermeticProfileSettings', () => {
  it.each([
    [
      'pins cmd.exe for a hermetic Windows launch',
      HERMETIC_SHELL_ENV,
      'win32',
      { terminalWindowsShell: 'cmd.exe' }
    ],
    ['leaves a hermetic macOS launch to SHELL', HERMETIC_SHELL_ENV, 'darwin', {}],
    ['leaves a plain Windows launch alone', {}, 'win32', {}]
  ] as const)('%s', (_name, env, platform, settings) => {
    expect(hermeticProfileSettings(env, platform)).toEqual(settings)
  })
})

describe('resolveE2EFixtureTmpdir', () => {
  it.each([
    [
      'keeps a macOS tmpdir outside home',
      '/Users/ada',
      '/var/folders/xy/T',
      'darwin',
      '/var/folders/xy/T'
    ],
    [
      'keeps a Windows runner temp on another drive',
      'C:\\Users\\runner',
      'D:\\a\\_temp',
      'win32',
      'D:\\a\\_temp'
    ],
    ['keeps a sibling of home', '/home/ada', '/home/ada2/tmp', 'linux', '/home/ada2/tmp'],
    [
      'moves a POSIX TMPDIR inside home to /tmp',
      '/Users/ada',
      '/Users/ada/tmp',
      'darwin',
      '/tmp/orca-e2e'
    ],
    [
      'moves Windows %TEMP% to its drive root, ignoring case',
      'C:\\Users\\Ada',
      'c:\\users\\ada\\AppData\\Local\\Temp',
      'win32',
      'c:\\orca-e2e'
    ]
  ] as const)('%s', (_name, realHome, tmpdir, platform, root) => {
    expect(resolveE2EFixtureTmpdir(realHome, tmpdir, platform)).toBe(root)
  })
})
