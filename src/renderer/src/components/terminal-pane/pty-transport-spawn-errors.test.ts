import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTerminalSessionStateSaveFailureMessage } from '../../../../shared/terminal-session-state-save-failure'
import { installIpcPtyWindow, restorePtySpecWindow } from './pty-transport-test-harness'

describe('createIpcPtyTransport', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window

  beforeEach(() => {
    vi.resetModules()
    installIpcPtyWindow(originalWindow, {})
  })

  afterEach(() => {
    restorePtySpecWindow(originalWindow)
  })

  it('suppresses the error toast when pty:spawn rejects with TerminalKilledError', async () => {
    // Why: a killed-session TerminalKilledError is intended, not a bug, so no toast; string is Electron's IPC-wrapped form to hit the real path.
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawnMock = vi
      .fn()
      .mockRejectedValue(
        new Error(
          `Error invoking remote method 'pty:spawn': TerminalKilledError: Session "pty-dead" was explicitly killed`
        )
      )

    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          spawn: spawnMock,
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          onData: vi.fn(() => () => {}),
          onReplay: vi.fn(() => () => {}),
          onExit: vi.fn(() => () => {})
        }
      }
    } as unknown as typeof window

    const transport = createIpcPtyTransport()
    const onError = vi.fn()

    const result = await transport.connect({
      url: '',
      sessionId: 'pty-dead',
      callbacks: { onError }
    })

    expect(onError).not.toHaveBeenCalled()
    expect(result).toBeUndefined()
  })

  it('still surfaces non-kill spawn errors via onError', async () => {
    // Why: keep TerminalKilledError suppression narrow so real spawn failures (bad cwd, missing shell) still reach the user.
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawnMock = vi.fn().mockRejectedValue(new Error('ENOENT: spawn /bin/nope not found'))

    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          spawn: spawnMock,
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          onData: vi.fn(() => () => {}),
          onReplay: vi.fn(() => () => {}),
          onExit: vi.fn(() => () => {})
        }
      }
    } as unknown as typeof window

    const transport = createIpcPtyTransport()
    const onError = vi.fn()

    await transport.connect({
      url: '',
      callbacks: { onError }
    })

    expect(onError).toHaveBeenCalledWith('ENOENT: spawn /bin/nope not found')
  })

  it('surfaces the SSH-not-active toast for a regular SSH target with no PTY provider', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawnMock = vi.fn().mockRejectedValue(new Error('No PTY provider for connection ssh-1'))
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          spawn: spawnMock,
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          onData: vi.fn(() => () => {}),
          onReplay: vi.fn(() => () => {}),
          onExit: vi.fn(() => () => {})
        }
      }
    } as unknown as typeof window

    const onError = vi.fn()
    await createIpcPtyTransport({ connectionId: 'ssh-1' }).connect({
      url: '',
      callbacks: { onError }
    })

    expect(onError).toHaveBeenCalledWith(
      'SSH connection is not active. Use the reconnect dialog or Settings to connect.'
    )
  })

  it('suppresses the SSH-not-active toast for a runtime-owned (per-workspace-env) target', async () => {
    // Why: a runtime-owned SSH target disappearing is expected teardown (no reconnect dialog exists), so no toast should fire.
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawnMock = vi
      .fn()
      .mockRejectedValue(new Error('No PTY provider for connection runtime-ssh-orca-1'))
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          spawn: spawnMock,
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          onData: vi.fn(() => () => {}),
          onReplay: vi.fn(() => () => {}),
          onExit: vi.fn(() => () => {})
        }
      }
    } as unknown as typeof window

    const onError = vi.fn()
    await createIpcPtyTransport({ connectionId: 'runtime-ssh-orca-1' }).connect({
      url: '',
      callbacks: { onError }
    })

    expect(onError).not.toHaveBeenCalled()
  })

  it('refuses to call a cross-connection SSH reattach expired, and still raises no error toast', async () => {
    // Client-side connection mismatch proves no host exit, even after same-machine re-adoption; keep it unverifiable to avoid duplicate resume while preserving toast suppression (#7661).
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawnMock = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'PTY ssh:ssh-1779863656395-57g1q1@@pty-3 belongs to SSH connection "ssh-1779863656395-57g1q1"'
        )
      )
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          spawn: spawnMock,
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          onData: vi.fn(() => () => {}),
          onReplay: vi.fn(() => () => {}),
          onExit: vi.fn(() => () => {})
        }
      }
    } as unknown as typeof window

    const onError = vi.fn()
    const result = await createIpcPtyTransport({ connectionId: 'ssh-other' }).connect({
      url: '',
      sessionId: 'ssh:ssh-1779863656395-57g1q1@@pty-3',
      callbacks: { onError }
    })

    expect(onError).not.toHaveBeenCalled()
    // Unaddressable IDs remain unverifiable and cannot authorize respawn.
    expect(result).toBeUndefined()
  })

  it('still calls a relay-attested gone session expired so a truly dead PTY respawns', async () => {
    // Relay-proven expiry still authorizes respawn; only client mismatch lost that authority.
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawnMock = vi.fn().mockRejectedValue(new Error('SSH_SESSION_EXPIRED: ssh:ssh-1@@pty-3'))
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          spawn: spawnMock,
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          onData: vi.fn(() => () => {}),
          onReplay: vi.fn(() => () => {}),
          onExit: vi.fn(() => () => {})
        }
      }
    } as unknown as typeof window

    const onError = vi.fn()
    const result = await createIpcPtyTransport({ connectionId: 'ssh-1' }).connect({
      url: '',
      sessionId: 'ssh:ssh-1@@pty-3',
      callbacks: { onError }
    })

    expect(onError).not.toHaveBeenCalled()
    expect(result).toEqual({ id: 'ssh:ssh-1@@pty-3', sessionExpired: true })
  })

  it('calls a local daemon session-absence answer expired so a restored pane respawns silently', async () => {
    // 'Session not found' is the daemon's absence verdict for a reattach id — the expected answer
    // at project open for panes whose sessions died with a daemon restart or the project-close
    // sweep. The pane retires the binding and respawns either way; the dead-session toast over the
    // recovered pane read as a broken tab on every project open.
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawnMock = vi
      .fn()
      .mockRejectedValue(
        new Error(
          `Error invoking remote method 'pty:spawn': SessionNotFoundError: Session not found: repo-1::C:/proj/wt@@deadbeef`
        )
      )
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          spawn: spawnMock,
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          onData: vi.fn(() => () => {}),
          onReplay: vi.fn(() => () => {}),
          onExit: vi.fn(() => () => {})
        }
      }
    } as unknown as typeof window

    const transport = createIpcPtyTransport()
    const onError = vi.fn()
    const result = await transport.connect({
      url: '',
      sessionId: 'repo-1::C:/proj/wt@@deadbeef',
      callbacks: { onError }
    })

    expect(onError).not.toHaveBeenCalled()
    expect(result).toEqual({ id: 'repo-1::C:/proj/wt@@deadbeef', sessionExpired: true })
  })

  it('surfaces terminal session state save failures without the Electron IPC wrapper', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const wrappedMessage = `Error invoking remote method 'pty:spawn': Error: ${createTerminalSessionStateSaveFailureMessage()}`
    const spawnMock = vi.fn().mockRejectedValue(new Error(wrappedMessage))

    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          spawn: spawnMock,
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          onData: vi.fn(() => () => {}),
          onReplay: vi.fn(() => () => {}),
          onExit: vi.fn(() => () => {})
        }
      }
    } as unknown as typeof window

    const transport = createIpcPtyTransport()
    const onError = vi.fn()

    await transport.connect({
      url: '',
      callbacks: { onError }
    })

    expect(onError).toHaveBeenCalledWith(createTerminalSessionStateSaveFailureMessage())
  })

  it('keeps every line of a multi-line spawn failure for the pane toast (#20386)', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const diagnosis =
      'Remote terminals are unavailable: make and a C++ compiler are not installed. Install them on the remote host, then reconnect:\n' +
      '  sudo apt-get install -y build-essential python3\n' +
      'Host: linux/x64, glibc 2.36, Node v22.12.0 (ABI 127), prebuild slot linux-x64-glibc.'
    vi.mocked(window.api.pty.spawn).mockRejectedValueOnce(
      new Error(`Error invoking remote method 'pty:spawn': Error: ${diagnosis}`)
    )

    const onError = vi.fn()
    await createIpcPtyTransport({ connectionId: 'ssh-1' }).connect({
      url: '',
      callbacks: { onError }
    })

    expect(onError).toHaveBeenCalledWith(diagnosis)
  })
})
