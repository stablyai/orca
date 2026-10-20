import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from './constants'
import {
  getDefaultPrimarySelectionMiddleClickPaste,
  getDefaultTerminalRightClickToPaste
} from './terminal-platform-defaults'

describe('getDefaultSettings', () => {
  it('uses platform-consistent separators for the default workspace directory', () => {
    expect(getDefaultSettings('/Users/alice').workspaceDir).toBe('/Users/alice/orca/workspaces')
    expect(getDefaultSettings('C:\\Users\\alice').workspaceDir).toBe(
      'C:\\Users\\alice\\orca\\workspaces'
    )
  })

  it('asks before closing terminals with running processes by default', () => {
    expect(getDefaultSettings('/tmp').skipCloseTerminalWithRunningProcessConfirm).toBe(false)
  })

  // ADB connection state is derived live from `adb devices -l` and must never
  // be persisted — only the configured address is a setting, and it defaults
  // unset like mobileEmulatorDefaultDeviceUdid.
  it('has no saved ADB device address by default', () => {
    expect(getDefaultSettings('/tmp').mobileEmulatorAdbAddress).toBeNull()
  })
})

describe('getDefaultPrimarySelectionMiddleClickPaste', () => {
  it('enables primary selection paste on Linux by default', () => {
    expect(getDefaultPrimarySelectionMiddleClickPaste('linux')).toBe(true)
  })

  it('enables primary selection paste on macOS by default', () => {
    expect(getDefaultPrimarySelectionMiddleClickPaste('darwin')).toBe(true)
  })

  it('leaves primary selection paste opt-in on Windows', () => {
    expect(getDefaultPrimarySelectionMiddleClickPaste('win32')).toBe(false)
  })
})

describe('getDefaultTerminalRightClickToPaste', () => {
  it('defaults on only for Windows', () => {
    expect(getDefaultTerminalRightClickToPaste('win32')).toBe(true)
    expect(getDefaultTerminalRightClickToPaste('darwin')).toBe(false)
    expect(getDefaultTerminalRightClickToPaste('linux')).toBe(false)
  })
})
