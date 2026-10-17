// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildWindowsShellMenuEntries } from '../components/tab-bar/tab-bar-windows-shell-options'
import { readWindowsTerminalCapabilities } from './windows-terminal-capability-read'

afterEach(() => vi.unstubAllGlobals())

describe('Niubash terminal choices', () => {
  const menu = {
    showWindowsShellMenu: true,
    hasShellLauncher: true,
    projectRuntimeShellMenuMode: 'host' as const,
    defaultWindowsShell: 'niu.exe',
    gitBashAvailable: false,
    wslAvailable: false
  }

  it('shows installed niu first when it is the default', () => {
    expect(buildWindowsShellMenuEntries({ ...menu, niubashAvailable: true })?.[0]).toEqual({
      label: 'Niubash',
      shell: 'niu.exe'
    })
    expect(buildWindowsShellMenuEntries(menu)?.some((entry) => entry.shell === 'niu.exe')).toBe(
      false
    )
  })

  it('does not offer the Windows niu executable inside a WSL project', () => {
    expect(
      buildWindowsShellMenuEntries({
        ...menu,
        niubashAvailable: true,
        projectRuntimeShellMenuMode: 'wsl',
        wslAvailable: true
      })
    ).toEqual([{ label: 'WSL', shell: 'wsl.exe' }])
  })

  it.each([true, false])(
    'reads local niu availability from its execution host (%s)',
    async (installed) => {
      const call = vi.fn().mockResolvedValue({ ok: true, result: installed })
      vi.stubGlobal('window', {
        api: {
          wsl: { isAvailable: async () => false, listDistros: async () => [] },
          pwsh: { isAvailable: async () => false },
          gitBash: { isAvailable: async () => false },
          runtime: { getStatus: async () => ({ hostPlatform: 'win32' }), call }
        }
      })
      expect(
        (await readWindowsTerminalCapabilities({ kind: 'local' })).niubashAvailable ?? false
      ).toBe(installed)
      expect(call).toHaveBeenCalledWith({ method: 'host.niubash.isAvailable', params: undefined })
    }
  )

  it('uses the SSH host response, not the desktop installation', async () => {
    const call = vi.fn()
    vi.stubGlobal('window', {
      api: {
        runtime: { call },
        preflight: {
          detectRemoteWindowsTerminalCapabilities: async () => ({
            wslAvailable: false,
            wslDistros: [],
            pwshAvailable: false,
            gitBashAvailable: false,
            hostPlatform: 'win32',
            niubashAvailable: true
          })
        }
      }
    })
    expect(
      (await readWindowsTerminalCapabilities({ kind: 'local' }, 'ssh-host')).niubashAvailable
    ).toBe(true)
    expect(call).not.toHaveBeenCalled()
  })

  it('keeps existing shells available when an older host does not know niu', async () => {
    vi.stubGlobal('window', {
      api: {
        wsl: { isAvailable: async () => false, listDistros: async () => [] },
        pwsh: { isAvailable: async () => true },
        gitBash: { isAvailable: async () => true },
        runtime: {
          getStatus: async () => ({ hostPlatform: 'win32' }),
          call: async () => ({
            ok: false,
            error: { code: 'METHOD_NOT_FOUND', message: 'unknown method' }
          })
        }
      }
    })
    expect(await readWindowsTerminalCapabilities({ kind: 'local' })).toMatchObject({
      pwshAvailable: true,
      gitBashAvailable: true
    })
  })
})
