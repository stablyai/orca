import { describe, expect, it } from 'vitest'
import { shouldShowWindowsShellMenu } from './windows-shell-menu-visibility'

describe('shouldShowWindowsShellMenu', () => {
  it('shows local Windows shells for a local Windows client without a runtime owner', () => {
    expect(
      shouldShowWindowsShellMenu({
        activeRuntimeEnvironmentId: null,
        hostPlatform: null,
        isWindowsClient: true,
        worktreeHasRemoteConnection: false
      })
    ).toBe(true)
  })

  it('keeps the menu hidden while a runtime host platform is unknown', () => {
    expect(
      shouldShowWindowsShellMenu({
        activeRuntimeEnvironmentId: 'serve-env-1',
        hostPlatform: null,
        isWindowsClient: true,
        worktreeHasRemoteConnection: false
      })
    ).toBe(false)
  })

  it('shows runtime Windows shells only after the runtime host is known to be Windows', () => {
    expect(
      shouldShowWindowsShellMenu({
        activeRuntimeEnvironmentId: 'serve-env-1',
        hostPlatform: 'win32',
        isWindowsClient: false,
        worktreeHasRemoteConnection: false
      })
    ).toBe(true)
  })

  it('hides local Windows shells for a non-Windows runtime host', () => {
    expect(
      shouldShowWindowsShellMenu({
        activeRuntimeEnvironmentId: 'serve-env-1',
        hostPlatform: 'linux',
        isWindowsClient: true,
        worktreeHasRemoteConnection: false
      })
    ).toBe(false)
  })

  it('shows Windows shells for SSH worktrees when the remote host is Windows', () => {
    expect(
      shouldShowWindowsShellMenu({
        activeRuntimeEnvironmentId: null,
        hostPlatform: 'win32',
        isWindowsClient: true,
        worktreeHasRemoteConnection: true
      })
    ).toBe(true)
  })

  it('hides Windows shells for SSH worktrees when the remote host is Linux', () => {
    expect(
      shouldShowWindowsShellMenu({
        activeRuntimeEnvironmentId: null,
        hostPlatform: 'linux',
        isWindowsClient: true,
        worktreeHasRemoteConnection: true
      })
    ).toBe(false)
  })
})
