import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import {
  buildWindowsPtyCompatibilityOptions,
  isLocalNativeWindowsConpty,
  isLocalNativeWindowsPty,
  resolveWindowsShellOverride
} from './windows-pty-compatibility'

function writeTerminal(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

describe('buildWindowsPtyCompatibilityOptions', () => {
  it('returns ConPTY compatibility options for local Windows terminals', () => {
    expect(
      buildWindowsPtyCompatibilityOptions({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        osRelease: '10.0.26100',
        connectionId: null,
        cwd: 'C:\\repo',
        shellOverride: null,
        executionHostId: 'local'
      })
    ).toEqual({
      windowsPty: { backend: 'conpty', buildNumber: 26100 }
    })
  })

  it('keeps ConPTY enabled when the Windows release cannot be parsed', () => {
    expect(
      buildWindowsPtyCompatibilityOptions({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        osRelease: 'bad-release',
        connectionId: null,
        cwd: 'C:\\repo',
        shellOverride: null,
        executionHostId: 'local'
      })
    ).toEqual({
      windowsPty: { backend: 'conpty' }
    })
  })

  it('omits old Windows build numbers that enable xterm legacy wrap heuristics', () => {
    expect(
      buildWindowsPtyCompatibilityOptions({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        osRelease: '10.0.19045',
        connectionId: null,
        cwd: 'C:\\repo',
        shellOverride: null,
        executionHostId: 'local'
      })
    ).toEqual({
      windowsPty: { backend: 'conpty' }
    })
  })

  it('does not mark the row after a full-width Windows status line as wrapped', async () => {
    const options = buildWindowsPtyCompatibilityOptions({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      osRelease: '10.0.19045',
      connectionId: null,
      cwd: 'C:\\repo',
      shellOverride: null,
      executionHostId: 'local'
    })
    const terminal = new Terminal({ cols: 20, rows: 5, ...options })

    await writeTerminal(terminal, `${'─'.repeat(20)}\r\nNEXT\r\n`)

    // Old Windows wrapping falsely joins full-width rows, breaking reported Chinese scrollback.
    expect(terminal.buffer.active.getLine(1)?.translateToString(true)).toBe('NEXT')
    expect(terminal.buffer.active.getLine(1)?.isWrapped).toBe(false)
  })

  it('skips compatibility options for SSH-backed Windows terminals', () => {
    expect(
      buildWindowsPtyCompatibilityOptions({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        osRelease: '10.0.26100',
        connectionId: 'ssh-1',
        cwd: 'C:\\repo',
        shellOverride: null,
        executionHostId: 'local'
      })
    ).toEqual({})
  })

  // ConPTY hosts local WSL shells too, so their emulator needs its resize model (awin verify-14).
  it('uses the ConPTY model for local WSL cwd terminals', () => {
    for (const cwd of [
      '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo',
      '\\\\wsl$\\Debian\\home\\me\\repo',
      '//wsl.localhost/Ubuntu/home/me/repo',
      '//wsl$/Debian/home/me/repo'
    ]) {
      expect(
        buildWindowsPtyCompatibilityOptions({
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          osRelease: '10.0.26100',
          connectionId: null,
          cwd,
          shellOverride: null,
          executionHostId: 'local'
        })
      ).toEqual({ windowsPty: { backend: 'conpty', buildNumber: 26100 } })
    }
  })

  it('uses the ConPTY model when the shell override launches WSL', () => {
    expect(
      buildWindowsPtyCompatibilityOptions({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        osRelease: '10.0.26100',
        connectionId: null,
        cwd: 'C:\\repo',
        shellOverride: 'C:\\Windows\\System32\\wsl.exe',
        executionHostId: 'local'
      })
    ).toEqual({ windowsPty: { backend: 'conpty', buildNumber: 26100 } })
  })

  it('returns no options outside Windows', () => {
    expect(
      buildWindowsPtyCompatibilityOptions({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)',
        osRelease: '23.0.0',
        connectionId: null,
        cwd: '/repo',
        shellOverride: null,
        executionHostId: 'local'
      })
    ).toEqual({})
  })

  it('does NOT return ConPTY options for a serve/remote-runtime pane even when the raw Windows heuristic matches', () => {
    // Serve panes look local to the raw heuristic; execution-host gating must exclude their remote Linux PTYs from ConPTY backend options.
    const serveContext = {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      osRelease: '10.0.26100',
      connectionId: null,
      cwd: '/home/me/workspaces/repo',
      shellOverride: null
    } as const
    expect(isLocalNativeWindowsPty(serveContext)).toBe(true)
    expect(
      buildWindowsPtyCompatibilityOptions({ ...serveContext, executionHostId: 'runtime:my-serve' })
    ).toEqual({})
  })

  it('does NOT return ConPTY options for an SSH-runtime pane', () => {
    expect(
      buildWindowsPtyCompatibilityOptions({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        osRelease: '10.0.26100',
        connectionId: null,
        cwd: 'C:\\repo',
        shellOverride: null,
        executionHostId: 'ssh:my-host'
      })
    ).toEqual({})
  })

  it('classifies a global-WSL default shell as non-native, matching main', () => {
    // Match main’s global terminalWindowsShell fold or renderer classifies tabs as ConPTY that main does not.
    const windowsUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    expect(
      isLocalNativeWindowsPty({
        userAgent: windowsUserAgent,
        connectionId: null,
        cwd: 'C:\\repo',
        shellOverride: resolveWindowsShellOverride(undefined, 'wsl.exe')
      })
    ).toBe(false)
    expect(
      isLocalNativeWindowsPty({
        userAgent: windowsUserAgent,
        connectionId: null,
        cwd: 'C:\\repo',
        shellOverride: resolveWindowsShellOverride('powershell.exe', 'wsl.exe')
      })
    ).toBe(true)
    expect(
      isLocalNativeWindowsPty({
        userAgent: windowsUserAgent,
        connectionId: null,
        cwd: 'C:\\repo',
        shellOverride: resolveWindowsShellOverride('wsl.exe', 'powershell.exe')
      })
    ).toBe(false)
  })

  it('exposes the same local native Windows predicate for related renderer workarounds', () => {
    expect(
      isLocalNativeWindowsPty({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        connectionId: null,
        cwd: 'C:\\repo',
        shellOverride: 'powershell.exe'
      })
    ).toBe(true)
    expect(
      isLocalNativeWindowsPty({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        connectionId: 'ssh-1',
        cwd: 'C:\\repo',
        shellOverride: 'powershell.exe'
      })
    ).toBe(false)
  })
})

describe('isLocalNativeWindowsConpty', () => {
  const localNativeWindowsContext = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    connectionId: null,
    cwd: 'C:\\repo',
    shellOverride: 'powershell.exe'
  } as const
  const remoteServePaneOnWindowsClientContext = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    connectionId: null,
    cwd: '/home/me/repo',
    shellOverride: null
  } as const

  it('treats a local-execution-host Windows pane as a native ConPTY', () => {
    expect(
      isLocalNativeWindowsConpty({ ...localNativeWindowsContext, executionHostId: 'local' })
    ).toBe(true)
  })

  it('does NOT treat a remote-runtime (serve) pane as a native ConPTY even when the raw Windows heuristic matches', () => {
    // Windows serve panes match the raw heuristic; exclude their remote PTYs from ConPTY cursor-show stripping or repainting hides agent cursors.
    expect(isLocalNativeWindowsPty(remoteServePaneOnWindowsClientContext)).toBe(true)
    expect(
      isLocalNativeWindowsConpty({
        ...remoteServePaneOnWindowsClientContext,
        executionHostId: 'runtime:my-serve'
      })
    ).toBe(false)
  })

  it('does NOT treat an SSH-runtime pane as a native ConPTY', () => {
    expect(
      isLocalNativeWindowsConpty({
        ...localNativeWindowsContext,
        executionHostId: 'ssh:my-host'
      })
    ).toBe(false)
  })

  it('does NOT treat unresolved connection ownership as native ConPTY', () => {
    expect(
      isLocalNativeWindowsConpty({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        connectionId: undefined,
        cwd: '/home/me/repo',
        shellOverride: null,
        executionHostId: 'local'
      })
    ).toBe(false)
  })

  it('stays false on a local host when the pane is not a native Windows PTY', () => {
    expect(
      isLocalNativeWindowsConpty({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)',
        connectionId: null,
        cwd: '/repo',
        shellOverride: null,
        executionHostId: 'local'
      })
    ).toBe(false)
  })

  it('does not let a local execution host re-enable protection the raw heuristic already suppressed', () => {
    // Local execution host is necessary, not sufficient; SSH and other raw exclusions must still win.
    expect(
      isLocalNativeWindowsConpty({
        ...localNativeWindowsContext,
        connectionId: 'ssh-1',
        executionHostId: 'local'
      })
    ).toBe(false)
  })
})
