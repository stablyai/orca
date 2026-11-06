import { describe, expect, it } from 'vitest'
import { resolveAntigravityInstallTarget } from './antigravity-install-target'

describe('resolveAntigravityInstallTarget', () => {
  it('keeps the user shell on POSIX hosts even with WSL context', () => {
    const target = resolveAntigravityInstallTarget('linux', { wslDistro: 'Ubuntu' }, true)
    expect(target?.runtime.runtime).toBe('host')
    expect(target?.shellOverride).toBeUndefined()
  })

  it('installs natively through PowerShell on Windows', () => {
    expect(resolveAntigravityInstallTarget('win32', undefined, true)).toMatchObject({
      shellOverride: 'powershell.exe',
      runtime: { runtime: 'host' }
    })
  })

  it('installs into the WSL distro agent detection reads', () => {
    expect(
      resolveAntigravityInstallTarget('win32', { wslDistro: 'Ubuntu-24.04' }, true)
    ).toMatchObject({
      shellOverride: 'powershell.exe',
      runtime: { runtime: 'wsl', wslDistro: 'Ubuntu-24.04' }
    })
  })

  it('offers no install when the WSL runtime needs repair', () => {
    expect(
      resolveAntigravityInstallTarget(
        'win32',
        {
          projectRuntime: {
            status: 'repair-required',
            repair: {
              projectId: 'folder-project',
              preferredRuntime: { kind: 'wsl', distro: null },
              reason: 'wsl-distro-required',
              source: 'global-default',
              cacheKey: 'repair'
            }
          }
        },
        true
      )
    ).toBeNull()
  })
})
