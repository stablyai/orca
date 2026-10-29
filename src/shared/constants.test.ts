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

  it('defaults git host web schemes empty so ssh remotes keep https until overridden', () => {
    expect(getDefaultSettings('/tmp').gitHostWebSchemes).toEqual({})
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
