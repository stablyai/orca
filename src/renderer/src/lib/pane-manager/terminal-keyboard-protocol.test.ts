import { describe, expect, it } from 'vitest'
import { buildTerminalKeyboardProtocolOptions } from './terminal-keyboard-protocol'

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
