import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readZcodeV2PlanCredential } from '../../../src/main/zcode/zcode-v2-plan-credentials'
import {
  areSameHomePath,
  assertElectronResolvedIsolatedHome,
  createElectronHomeIsolation
} from './electron-home-isolation'

const tempDirs: string[] = []

afterEach(() => {
  vi.unstubAllGlobals()
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
        CLAUDE_CONFIG_DIR: '/real/claude',
        ZDOTDIR: '/real/zdotdir',
        ORCA_DISABLE_MACOS_LOGIN_SHELL: 'false',
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
    expect(isolation.env.CLAUDE_CONFIG_DIR).toBeUndefined()
    expect(isolation.env.ZDOTDIR).toBeUndefined()
    expect(isolation.env.ORCA_DISABLE_MACOS_LOGIN_SHELL).toBe(
      process.platform === 'darwin' ? '1' : undefined
    )
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

  it('compares Windows home paths case-insensitively', () => {
    expect(areSameHomePath('C:\\Users\\Alice', 'c:\\users\\alice', 'win32')).toBe(true)
  })

  it.each(['launchEnv', 'extraEnv'] as const)(
    'rejects %s attempts to restore the macOS login wrapper',
    (overlay) => {
      expect(() =>
        createElectronHomeIsolation({
          inheritedEnv: {},
          launchEnv: overlay === 'launchEnv' ? { ORCA_DISABLE_MACOS_LOGIN_SHELL: '0' } : {},
          extraEnv: overlay === 'extraEnv' ? { ORCA_DISABLE_MACOS_LOGIN_SHELL: '0' } : {},
          userDataDir: createUserDataDir(),
          realHome: '/real/home'
        })
      ).toThrow(/ORCA_DISABLE_MACOS_LOGIN_SHELL/)
    }
  )
})

function installSyntheticPlan(home: string, apiKey: string): string {
  const dir = path.join(home, '.zcode', 'v2')
  mkdirSync(dir, { recursive: true })
  const providerId = 'account:bigmodel-individual-coding-plan'
  const configPath = path.join(dir, 'provider_config.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      schemaVersion: 1,
      config: {
        providerConfigRules: { providerRules: [] },
        modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
        defaultModelSelection: { providerId, modelId: 'GLM' }
      }
    })
  )
  writeFileSync(
    path.join(dir, 'credentials.json'),
    JSON.stringify({
      [`account-provider:${providerId}:identity`]: 'synthetic',
      [`account-provider:coding-plan:${providerId}:account:synthetic:api-key`]: apiKey
    })
  )
  return configPath
}

describe('ZCode credentials in the disposable home', () => {
  const credentialRoots = ['ZCODE_DATA_BASE_DIR', 'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE'] as const

  it.each(credentialRoots)('strips inherited %s before reading an isolated plan', (key) => {
    const externalHome = createUserDataDir()
    const externalConfig = installSyntheticPlan(externalHome, 'synthetic-external-key')
    const isolation = createElectronHomeIsolation({
      inheritedEnv: {
        [key]: key === 'ZCODE_DATA_BASE_DIR' ? externalHome : externalConfig
      },
      launchEnv: {},
      extraEnv: {},
      userDataDir: createUserDataDir(),
      realHome: externalHome
    })
    const configPath = installSyntheticPlan(isolation.isolatedHome, 'synthetic-isolated-key')
    const fetch = vi.fn(() => {
      throw new Error('Credential isolation must not use the network')
    })
    vi.stubGlobal('fetch', fetch)
    expect(
      readZcodeV2PlanCredential({
        home: isolation.isolatedHome,
        platform: process.platform,
        username: 'synthetic-user',
        env: isolation.env
      })
    ).toMatchObject({ status: 'ok', apiKey: 'synthetic-isolated-key', configPath })
    expect(isolation.env[key]).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['launchEnv', 'extraEnv'] as const)('rejects %s credential-root overlays', (overlay) => {
    const externalHome = createUserDataDir()
    const externalConfig = installSyntheticPlan(externalHome, 'synthetic-external-key')
    for (const key of credentialRoots) {
      for (const spelling of [key, key.toLowerCase()]) {
        const override = {
          [spelling]: key === 'ZCODE_DATA_BASE_DIR' ? externalHome : externalConfig
        }
        expect(() =>
          createElectronHomeIsolation({
            inheritedEnv: {},
            launchEnv: overlay === 'launchEnv' ? override : {},
            extraEnv: overlay === 'extraEnv' ? override : {},
            userDataDir: createUserDataDir(),
            realHome: externalHome
          })
        ).toThrow(
          `${overlay === 'launchEnv' ? 'launchEnv' : 'orcaAppExtraEnv'}.${spelling} cannot override the E2E home boundary`
        )
      }
    }
  })

  it('reads ordinary home fixtures while retaining legitimate launch overrides', () => {
    const isolation = createElectronHomeIsolation({
      inheritedEnv: { PATH: '/synthetic/bin' },
      launchEnv: { ORCA_DISABLE_AGENT_HOOKS: '1', TEST_TOKEN: 'launch' },
      extraEnv: { TEST_TOKEN: 'extra', ZCODE_CREDENTIAL_SECRET: 'synthetic-secret' },
      userDataDir: createUserDataDir(),
      realHome: createUserDataDir()
    })
    const configPath = installSyntheticPlan(isolation.isolatedHome, 'synthetic-ordinary-key')
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('Network forbidden')
      })
    )
    expect(isolation.env).toMatchObject({
      PATH: '/synthetic/bin',
      ORCA_DISABLE_AGENT_HOOKS: '1',
      TEST_TOKEN: 'extra',
      ZCODE_CREDENTIAL_SECRET: 'synthetic-secret'
    })
    expect(
      readZcodeV2PlanCredential({
        home: isolation.isolatedHome,
        platform: process.platform,
        username: 'synthetic-user',
        env: isolation.env
      })
    ).toMatchObject({ status: 'ok', apiKey: 'synthetic-ordinary-key', configPath })
    expect(fetch).not.toHaveBeenCalled()
  })
})
