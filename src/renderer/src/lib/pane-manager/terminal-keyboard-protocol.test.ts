import { describe, expect, it } from 'vitest'
import {
  buildTerminalKeyboardProtocolOptions,
  shouldDisableKittyKeyboardForTerminal
} from './terminal-keyboard-protocol'

const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)'
const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64)'

describe('shouldDisableKittyKeyboardForTerminal', () => {
  it('disables Kitty keyboard for a local native Windows ConPTY pane', () => {
    // Regression for #2434: local Windows CLIs (e.g. Antigravity agy) read the
    // advertisement but do not decode CSI-u, so enhanced reporting swallows
    // Enter/Up/Down navigation. The advertisement must be withheld here.
    expect(
      shouldDisableKittyKeyboardForTerminal({
        userAgent: WINDOWS_UA,
        osRelease: '10.0.26100',
        connectionId: null,
        cwd: 'C:\\repo',
        shellOverride: 'powershell.exe',
        executionHostId: 'local'
      })
    ).toBe(true)
  })

  it('keeps Kitty keyboard for an SSH-backed Windows-client pane', () => {
    expect(
      shouldDisableKittyKeyboardForTerminal({
        userAgent: WINDOWS_UA,
        osRelease: '10.0.26100',
        connectionId: 'ssh-1',
        cwd: 'C:\\repo',
        shellOverride: null,
        executionHostId: 'local'
      })
    ).toBe(false)
  })

  it('keeps Kitty keyboard for an SSH-runtime pane on a Windows client', () => {
    expect(
      shouldDisableKittyKeyboardForTerminal({
        userAgent: WINDOWS_UA,
        osRelease: '10.0.26100',
        connectionId: null,
        cwd: 'C:\\repo',
        shellOverride: null,
        executionHostId: 'ssh:my-host'
      })
    ).toBe(false)
  })

  it('keeps Kitty keyboard for a serve/remote-runtime pane on a Windows client', () => {
    // A serve pane has no SSH connectionId and a Linux cwd, so the raw Windows
    // heuristic matches; the execution-host gate must still preserve enhanced
    // reporting for the remote Linux PTY that decodes CSI-u correctly.
    expect(
      shouldDisableKittyKeyboardForTerminal({
        userAgent: WINDOWS_UA,
        osRelease: '10.0.26100',
        connectionId: null,
        cwd: '/home/me/workspaces/repo',
        shellOverride: null,
        executionHostId: 'runtime:my-serve'
      })
    ).toBe(false)
  })

  it('keeps Kitty keyboard for a WSL pane on a Windows client', () => {
    expect(
      shouldDisableKittyKeyboardForTerminal({
        userAgent: WINDOWS_UA,
        osRelease: '10.0.26100',
        connectionId: null,
        cwd: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo',
        shellOverride: null,
        executionHostId: 'local'
      })
    ).toBe(false)
  })

  it('keeps Kitty keyboard on macOS', () => {
    expect(
      shouldDisableKittyKeyboardForTerminal({
        userAgent: MAC_UA,
        osRelease: '23.0.0',
        connectionId: null,
        cwd: '/repo',
        shellOverride: null,
        executionHostId: 'local'
      })
    ).toBe(false)
  })

  it('keeps Kitty keyboard on Linux', () => {
    expect(
      shouldDisableKittyKeyboardForTerminal({
        userAgent: LINUX_UA,
        osRelease: '6.5.0',
        connectionId: null,
        cwd: '/repo',
        shellOverride: null,
        executionHostId: 'local'
      })
    ).toBe(false)
  })
})

describe('buildTerminalKeyboardProtocolOptions', () => {
  it('withholds the Kitty keyboard advertisement for a local Windows ConPTY pane', () => {
    expect(
      buildTerminalKeyboardProtocolOptions({
        userAgent: WINDOWS_UA,
        osRelease: '10.0.26100',
        connectionId: null,
        cwd: 'C:\\repo',
        shellOverride: 'powershell.exe',
        executionHostId: 'local'
      })
    ).toEqual({ vtExtensions: { kittyKeyboard: false } })
  })

  it('returns no override for SSH panes so enhanced reporting stays advertised', () => {
    expect(
      buildTerminalKeyboardProtocolOptions({
        userAgent: WINDOWS_UA,
        osRelease: '10.0.26100',
        connectionId: 'ssh-1',
        cwd: 'C:\\repo',
        shellOverride: null,
        executionHostId: 'local'
      })
    ).toEqual({})
  })

  it('returns no override on macOS/Linux', () => {
    for (const userAgent of [MAC_UA, LINUX_UA]) {
      expect(
        buildTerminalKeyboardProtocolOptions({
          userAgent,
          osRelease: '23.0.0',
          connectionId: null,
          cwd: '/repo',
          shellOverride: null,
          executionHostId: 'local'
        })
      ).toEqual({})
    }
  })
})
