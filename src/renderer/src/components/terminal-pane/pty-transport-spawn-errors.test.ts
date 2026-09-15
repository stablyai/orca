import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  formatRuntimeOwnedSshRelayNotAttached,
  formatRuntimeOwnedSshRelayReattachFailed
} from '../../../../shared/ssh-pty-provider-missing'
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

  // Why these inputs come from the shared formatters: they are what main's registry and
  // spawn-time re-attach actually throw (Electron wraps them in the invoke prefix); a
  // hand-written literal would drift from that shape and keep passing.
  it.each([
    [
      'the relay was never re-attached',
      formatRuntimeOwnedSshRelayNotAttached('runtime-ssh-orca-1'),
      'The SSH relay for this workspace is not attached. ' +
        'Open the workspace again or start a new terminal to retry.'
    ],
    [
      'the spawn-time re-attach failed',
      formatRuntimeOwnedSshRelayReattachFailed(
        'runtime-ssh-orca-1',
        'connect ECONNREFUSED 127.0.0.1:51816'
      ),
      'Could not re-attach the SSH relay for this workspace: connect ECONNREFUSED 127.0.0.1:51816. ' +
        'Open the workspace again or start a new terminal to retry.'
    ]
  ])(
    'tells a runtime-owned (per-workspace-env) pane its real retry when %s',
    async (_label, mainMessage, expected) => {
      // Why: runtime-owned targets have no reconnect dialog, Settings entry, or host-list
      // Reconnect — main excludes them from listTargets — so the canned "use Settings" line
      // would name a control that does not exist. The pane gets the cause main reported plus
      // the retry the user actually has, without the internal target id.
      const { createIpcPtyTransport } = await import('./pty-transport')
      const spawnMock = vi
        .fn()
        .mockRejectedValue(new Error(`Error invoking remote method 'pty:spawn': ${mainMessage}`))
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

      expect(onError).toHaveBeenCalledTimes(1)
      expect(onError).toHaveBeenCalledWith(expected)
      expect(onError).not.toHaveBeenCalledWith(expect.stringContaining('runtime-ssh-orca-1'))
      expect(onError).not.toHaveBeenCalledWith(expect.stringMatching(/Settings|Reconnect on/))
    }
  )

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
