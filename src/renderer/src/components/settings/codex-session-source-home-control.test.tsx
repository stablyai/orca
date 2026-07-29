import { describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/types'
import { buildCodexSessionSourceHomeControl } from './codex-session-source-home-control'

function settingsWith(
  overrides: Partial<Pick<GlobalSettings, 'codexSessionSourceHome' | 'localWindowsRuntimeDefault'>>
): Pick<GlobalSettings, 'codexSessionSourceHome' | 'localWindowsRuntimeDefault'> {
  return {
    codexSessionSourceHome: overrides.codexSessionSourceHome,
    localWindowsRuntimeDefault: overrides.localWindowsRuntimeDefault ?? { kind: 'windows-host' }
  }
}

describe('buildCodexSessionSourceHomeControl', () => {
  it('reads and writes the host override on the host runtime', () => {
    const updateSettings = vi.fn()
    const control = buildCodexSessionSourceHomeControl(
      settingsWith({ codexSessionSourceHome: { host: '/custom/codex' } }),
      updateSettings
    )

    expect(control.runtimeLabel).toBe('~/.codex')
    expect(control.value).toBe('/custom/codex')

    control.onSave('/new/codex')
    expect(updateSettings).toHaveBeenCalledWith({
      codexSessionSourceHome: { host: '/new/codex' }
    })
  })

  it('scopes to the selected WSL distro', () => {
    const updateSettings = vi.fn()
    const control = buildCodexSessionSourceHomeControl(
      settingsWith({
        codexSessionSourceHome: { wsl: { Ubuntu: '/home/me/.codex' } },
        localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
      }),
      updateSettings
    )

    expect(control.value).toBe('/home/me/.codex')
    control.onSave('/home/me/.config/codex')
    expect(updateSettings).toHaveBeenCalledWith({
      codexSessionSourceHome: { wsl: { Ubuntu: '/home/me/.config/codex' } }
    })
  })

  it('reads a stored WSL value when the reported distro casing differs', () => {
    // Stored as "Ubuntu"; the runtime reports "ubuntu". The launch-time resolver
    // matches case-insensitively, so the UI must surface the active value too.
    const control = buildCodexSessionSourceHomeControl(
      settingsWith({
        codexSessionSourceHome: { wsl: { Ubuntu: '/home/me/.codex' } },
        localWindowsRuntimeDefault: { kind: 'wsl', distro: 'ubuntu' }
      }),
      vi.fn()
    )

    expect(control.value).toBe('/home/me/.codex')
  })

  it('updates the existing WSL key in place instead of creating a duplicate casing', () => {
    const updateSettings = vi.fn()
    const control = buildCodexSessionSourceHomeControl(
      settingsWith({
        codexSessionSourceHome: { wsl: { Ubuntu: '/home/me/.codex' } },
        localWindowsRuntimeDefault: { kind: 'wsl', distro: 'ubuntu' }
      }),
      updateSettings
    )

    control.onSave('/home/me/.config/codex')
    // No stray "ubuntu" key alongside "Ubuntu".
    expect(updateSettings).toHaveBeenCalledWith({
      codexSessionSourceHome: { wsl: { Ubuntu: '/home/me/.config/codex' } }
    })
  })

  it('clears the matching WSL key regardless of casing when reset', () => {
    const updateSettings = vi.fn()
    const control = buildCodexSessionSourceHomeControl(
      settingsWith({
        codexSessionSourceHome: { wsl: { Ubuntu: '/home/me/.codex' } },
        localWindowsRuntimeDefault: { kind: 'wsl', distro: 'ubuntu' }
      }),
      updateSettings
    )

    control.onSave('')
    // Removing the only key leaves no dangling wsl object.
    expect(updateSettings).toHaveBeenCalledWith({
      codexSessionSourceHome: { wsl: undefined }
    })
  })

  it('falls back to the host control when a WSL scope has no selected distro', () => {
    const control = buildCodexSessionSourceHomeControl(
      settingsWith({
        codexSessionSourceHome: { host: '/custom/codex' },
        localWindowsRuntimeDefault: { kind: 'wsl', distro: null }
      }),
      vi.fn()
    )

    expect(control.runtimeLabel).toBe('~/.codex')
    expect(control.value).toBe('/custom/codex')
  })
})
