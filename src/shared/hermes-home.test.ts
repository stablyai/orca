import { join } from 'node:path'
import { homedir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { resolveDefaultHermesHomeDir, resolveHermesHomeDir } from './hermes-home'
import { hermesHostHomes } from '../main/ai-vault/session-scanner-hermes-stores'

afterEach(() => vi.unstubAllEnvs())
it('follows Hermes platform defaults and data suffix without probing filesystem state', () => {
  const homeDir = join('/users', 'ada')
  expect(
    resolveDefaultHermesHomeDir({
      homeDir,
      platform: 'linux',
      env: { HERMES_DATA_DIR_SUFFIX: '-dev' }
    })
  ).toBe(join(homeDir, '.hermes-dev'))
  expect(
    resolveDefaultHermesHomeDir({
      homeDir,
      platform: 'win32',
      env: { HERMES_DATA_DIR_SUFFIX: '-dev' }
    })
  ).toBe(join(homeDir, 'AppData', 'Local', 'hermes-dev'))
  expect(
    resolveDefaultHermesHomeDir({
      homeDir,
      platform: 'win32',
      env: { LOCALAPPDATA: 'relative\\local' }
    })
  ).toBe(join(homeDir, 'AppData', 'Local', 'hermes'))
  expect(
    resolveDefaultHermesHomeDir({
      homeDir,
      platform: 'win32',
      env: { LOCALAPPDATA: join('/local') }
    })
  ).toBe(join('/local', 'hermes'))
})
it('resolves an absolute override and keeps its owning root plus the legacy home discoverable', () => {
  const root = join('/custom', 'hermes')
  const profile = join(root, 'profiles', 'work')
  vi.stubEnv('HERMES_HOME', profile)
  expect(resolveHermesHomeDir()).toBe(profile)
  expect(hermesHostHomes({}, [])).toEqual([root, join(homedir(), '.hermes')])
  expect(resolveHermesHomeDir({ HERMES_HOME: 'relative/home' })).toBe(
    resolveDefaultHermesHomeDir({ env: {} })
  )
})
