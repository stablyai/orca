import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  preflight: vi.fn(),
  exec: vi.fn(),
  exists: vi.fn(),
  mkdtemp: vi.fn(),
  write: vi.fn()
}))

vi.mock('../../config/scripts/macos-gui-launch-preflight.mjs', () => ({
  assertMacGuiLaunchAllowed: fixture.preflight
}))

vi.mock('node:child_process', () => ({ execSync: fixture.exec }))
vi.mock('node:fs', () => ({
  existsSync: fixture.exists,
  mkdirSync: vi.fn(),
  mkdtempSync: fixture.mkdtemp,
  rmSync: vi.fn(),
  realpathSync: (value: string) => value,
  writeFileSync: fixture.write
}))
vi.mock('./helpers/docker-ssh-host-image', () => ({ prepareDockerSshHostImage: vi.fn() }))

vi.mock('./helpers/orca-app', () => ({ forwardElectronProcessLogs: vi.fn() }))
vi.mock('./helpers/e2e-completed-onboarding-profile', () => ({}))
vi.mock('./helpers/electron-process-shutdown', () => ({}))
vi.mock('./helpers/electron-home-isolation', () => ({}))
vi.mock('./helpers/orca-serve-cli-host', () => ({
  isolatedServeProfile: vi.fn(),
  spawnUntilReady: vi.fn()
}))

import globalSetup from './global-setup'
import { launchPackagedServeHost } from './helpers/packaged-old-orca'

beforeEach(() => {
  vi.resetAllMocks()
  fixture.exists.mockReturnValue(true)
  for (const name of [
    'SKIP_BUILD',
    'ORCA_E2E_WEB_CLIENT',
    'ORCA_E2E_SSH_DOCKER',
    'ORCA_E2E_SKILL_STAGING',
    'ORCA_E2E_TEST_REPO_PATH_FILE'
  ]) {
    vi.stubEnv(name, '')
  }
})

afterEach(() => vi.unstubAllEnvs())

describe('macOS GUI launch boundary', () => {
  it('refuses launch before preparing build artifacts or repositories', () => {
    fixture.preflight.mockImplementationOnce(() => {
      throw new Error('Launch denied')
    })
    expect(() => globalSetup()).toThrow('Launch denied')
    expect(fixture.preflight).toHaveBeenCalledOnce()
    expect(fixture.exec).not.toHaveBeenCalled()
    expect(fixture.mkdtemp).not.toHaveBeenCalled()
    expect(fixture.exists).not.toHaveBeenCalled()
    expect(fixture.write).not.toHaveBeenCalled()
  })

  it('refuses the packaged server before creating its profile or starting Electron', async () => {
    fixture.preflight.mockImplementationOnce(() => {
      throw new Error('Launch denied')
    })
    await expect(launchPackagedServeHost('/must-not-launch/Electron')).rejects.toThrow(
      'Launch denied'
    )
    expect(fixture.preflight).toHaveBeenCalledOnce()
    expect(fixture.mkdtemp).not.toHaveBeenCalled()
  })
})
