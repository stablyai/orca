import { describe, expect, it } from 'vitest'
import {
  buildTerminalKeyboardProtocolOptions,
  shouldDisableKittyKeyboardForTerminal
} from './terminal-keyboard-protocol'

const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)'
const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64)'

const localWindowsConpty = {
  userAgent: WINDOWS_UA,
  osRelease: '10.0.26100',
  connectionId: null as string | null,
  cwd: 'C:\\repo',
  shellOverride: 'powershell.exe' as string | null,
  executionHostId: 'local' as const
}

describe('shouldDisableKittyKeyboardForTerminal', () => {
  it('disables Kitty keyboard for a local native Windows ConPTY pane', () => {
    // Withhold KKP for local ConPTY CLIs that advertise interest but ignore CSI-u navigation (e.g. Antigravity, #2434).
    expect(shouldDisableKittyKeyboardForTerminal(localWindowsConpty)).toBe(true)
  })

  it('keeps Kitty keyboard for Grok on a local Windows ConPTY pane', () => {
    // Grok needs KKP for Ctrl+Enter/Shift+Enter; known-agent evidence overrides normal ConPTY withholding.
    expect(
      shouldDisableKittyKeyboardForTerminal({
        ...localWindowsConpty,
        tuiAgent: 'grok'
      })
    ).toBe(false)
  })

  it('still withholds Kitty keyboard for non-Grok agents on local Windows ConPTY', () => {
    expect(
      shouldDisableKittyKeyboardForTerminal({
        ...localWindowsConpty,
        tuiAgent: 'claude'
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
    // Serve panes look local to the raw Windows heuristic; execution-host gating must preserve KKP for remote Linux.
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
    expect(buildTerminalKeyboardProtocolOptions(localWindowsConpty)).toEqual({
      vtExtensions: { kittyKeyboard: false }
    })
  })

  it('returns no override for Grok on local Windows ConPTY so KKP stays advertised', () => {
    expect(
      buildTerminalKeyboardProtocolOptions({
        ...localWindowsConpty,
        tuiAgent: 'grok'
      })
    ).toEqual({})
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
