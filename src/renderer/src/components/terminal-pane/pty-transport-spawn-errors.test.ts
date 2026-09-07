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
    // Retargeted from "…as expired instead of a red error toast" (#7661), which pinned the bug:
    // "belongs to SSH connection" is minted client-side by the id router before any relay is asked,
    // so it is not evidence the process died. `sessionExpired` cold-restores the agent, and after an
    // SSH target re-adoption the other connection is the SAME machine — two `claude --resume` on one
    // transcript. The no-toast half of #7661 is still pinned below; the verdict half is now unverifiable.
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
    // undefined, not a sessionExpired result: the reattach handler's no-pty-id branch routes an
    // SSH pane to recoverUnverifiableDirectSshReattach (remount + reattach, no shell restart).
    expect(result).toBeUndefined()
  })

  it('still calls a relay-attested gone session expired so a truly dead PTY respawns', async () => {
    // Guards the other direction of the change above: only the client-side mismatch lost its
    // respawn licence. SSH_SESSION_EXPIRED is the relay's own absence verdict and must keep it.
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
})
