import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from './constants'
import { resolveLocalAccountRuntimeTarget } from './local-account-runtime'

describe('resolveLocalAccountRuntimeTarget', () => {
  it('honors an explicit host pin', () => {
    expect(
      resolveLocalAccountRuntimeTarget(
        { ...getDefaultSettings('/tmp'), localAccountRuntime: 'host' },
        'win32'
      )
    ).toEqual({ runtime: 'host', wslDistro: null })
  })

  it('honors an explicit WSL pin and its distro', () => {
    expect(
      resolveLocalAccountRuntimeTarget(
        {
          ...getDefaultSettings('/tmp'),
          localAccountRuntime: 'wsl',
          localAccountWslDistro: 'Ubuntu'
        },
        'win32'
      )
    ).toEqual({ runtime: 'wsl', wslDistro: 'Ubuntu' })
  })

  it('auto follows the global WSL project runtime default', () => {
    expect(
      resolveLocalAccountRuntimeTarget(
        {
          ...getDefaultSettings('/tmp'),
          localAccountRuntime: 'auto',
          localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
        },
        'win32'
      )
    ).toEqual({ runtime: 'wsl', wslDistro: 'Ubuntu' })
  })

  it('auto resolves to host when the global project runtime is windows-host', () => {
    expect(
      resolveLocalAccountRuntimeTarget(
        {
          ...getDefaultSettings('/tmp'),
          localAccountRuntime: 'auto',
          localWindowsRuntimeDefault: { kind: 'windows-host' }
        },
        'win32'
      )
    ).toEqual({ runtime: 'host', wslDistro: null })
  })

  it('auto resolves to host on non-Windows platforms even with a WSL default', () => {
    expect(
      resolveLocalAccountRuntimeTarget(
        {
          ...getDefaultSettings('/tmp'),
          localAccountRuntime: 'auto',
          localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
        },
        'linux'
      )
    ).toEqual({ runtime: 'host', wslDistro: null })
  })
})
