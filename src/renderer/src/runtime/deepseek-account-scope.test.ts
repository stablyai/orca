import { describe, expect, it } from 'vitest'
import { createGlobalSettingsFixture } from '../../../shared/global-settings-test-fixture'
import { getDeepSeekAccountScope } from './deepseek-account-scope'

describe('DeepSeek execution host scope', () => {
  const settings = createGlobalSettingsFixture({ activeRuntimeEnvironmentId: 'default-host' })
  it('uses the folder or worktree execution host rather than the global default', () => {
    expect(getDeepSeekAccountScope(settings, 'runtime:workspace-host', 'darwin')).toEqual({
      environmentId: 'workspace-host',
      unsupported: false
    })
    expect(getDeepSeekAccountScope(settings, 'local', 'darwin')).toEqual({
      environmentId: null,
      unsupported: false
    })
  })
  it('retains the selected account host when there is no active workspace', () => {
    expect(getDeepSeekAccountScope(settings, null, 'linux')).toEqual({
      environmentId: 'default-host',
      unsupported: false
    })
  })
  it('explicitly rejects SSH and WSL backends without desktop fallback', () => {
    expect(getDeepSeekAccountScope(settings, 'ssh:remote', 'darwin')).toEqual({
      environmentId: null,
      unsupported: true
    })
    const wsl = createGlobalSettingsFixture({
      localAccountRuntime: 'auto',
      localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
    })
    expect(getDeepSeekAccountScope(wsl, 'local', 'win32')).toEqual({
      environmentId: null,
      unsupported: true
    })
    expect(getDeepSeekAccountScope(wsl, 'runtime:linux-host', 'win32')).toEqual({
      environmentId: 'linux-host',
      unsupported: false
    })
  })
})
