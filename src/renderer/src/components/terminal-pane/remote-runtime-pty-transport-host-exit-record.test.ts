import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRemoteRuntimeTransportMocks,
  readyHostSessionInventoryResponse,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'

const appStore = vi.hoisted(() => ({
  getState: vi.fn(() => {
    throw new Error('These transport fixtures must not read app-store ownership')
  })
}))

vi.mock('@/store', () => ({ useAppStore: { getState: appStore.getState } }))

afterEach(() => {
  expect(appStore.getState).not.toHaveBeenCalled()
})

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'

const {
  runtimeCall,
  subscriptionSendBinary,
  latestSubscribePayload,
  emitSnapshot,
  inputFrameTexts,
  subscribeFrameCount,
  resetRemoteRuntimeTransport
} = createRemoteRuntimeTransportMocks({
  getCallbacks: () => subscriptionCallbacks,
  setCallbacks: (callbacks) => {
    subscriptionCallbacks = callbacks
  },
  getResolvedPaneHandle: () => resolvedPaneHandle,
  setResolvedPaneHandle: (handle) => {
    resolvedPaneHandle = handle
  }
})

const HOST_TAB_PTY_ID = 'remote:hub-env@@terminal-ended'

type ShowParams = { terminal?: string }

function refuseStream(message: string): void {
  const streamId = latestSubscribePayload().streamId
  subscriptionCallbacks?.onResponse({ ok: true, result: { type: 'error', streamId, message } })
}

function answerShow(terminal: Record<string, unknown>): string[] {
  const shown: string[] = []
  const defaultCall = runtimeCall.getMockImplementation()
  runtimeCall.mockImplementation(async (args: { method: string; params?: ShowParams }) => {
    if (args.method === 'terminal.show') {
      shown.push(args.params?.terminal ?? '')
      return { ok: true, result: { terminal: { handle: 'terminal-ended', ...terminal } } }
    }
    if (args.method === 'session.tabs.list') {
      return readyHostSessionInventoryResponse('terminal-ended')
    }
    return defaultCall?.(args)
  })
  return shown
}

async function attachRestoredHostTab(
  onPtyExit: (ptyId: string, exitCode?: number) => void,
  onHostReboundExitedPty?: (ptyId: string) => void
) {
  resolvedPaneHandle = 'terminal-ended'
  const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
  const transport = createRemoteRuntimePtyTransport('hub-env', {
    worktreeId: 'wt-1',
    tabId: 'web-terminal-host-tab-1',
    leafId: 'pane:1',
    onPtyExit,
    ...(onHostReboundExitedPty ? { onHostReboundExitedPty } : {})
  })
  transport.attach({ existingPtyId: HOST_TAB_PTY_ID, callbacks: {} })
  await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
  emitSnapshot(latestSubscribePayload().streamId, 'transcript')
  return transport
}

async function publishHostSurface(
  surface: { terminal: string; incarnationId?: string } | null,
  snapshotVersion: number
): Promise<void> {
  const tab = {
    type: 'terminal' as const,
    id: 'host-tab-1::pane:1',
    parentTabId: 'host-tab-1',
    leafId: 'pane:1',
    title: 'Terminal',
    isActive: true
  }
  // Why dynamic: the harness resets modules, so the transport's channel is the freshly loaded one.
  const { queueAcceptedWebSessionTerminalSnapshot } =
    await import('../../runtime/web-session-terminal-handle-events')
  queueAcceptedWebSessionTerminalSnapshot(
    {
      worktree: 'wt-1',
      publicationEpoch: 'epoch-ready',
      snapshotVersion,
      activeGroupId: null,
      activeTabId: tab.id,
      activeTabType: 'terminal',
      tabs: [
        surface
          ? { ...tab, status: 'ready', ...surface }
          : { ...tab, status: 'pending-handle', terminal: null }
      ]
    },
    'hub-env'
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('remote runtime pane whose host session already ended (#31539)', () => {
  beforeEach(() => {
    resetRemoteRuntimeTransport()
  })

  it('settles a stale restored pane as exited when the host verdict is exited', async () => {
    const onPtyExit = vi.fn()
    const transport = await attachRestoredHostTab(onPtyExit)
    const shown = answerShow({
      connected: false,
      verdict: 'exited',
      exitCause: { kind: 'exited', exitCode: 3 }
    })

    refuseStream('terminal_handle_stale')

    await vi.waitFor(() => expect(onPtyExit).toHaveBeenCalledWith(HOST_TAB_PTY_ID, 3))
    expect(onPtyExit).toHaveBeenCalledOnce()
    expect(shown).toEqual(['terminal-ended'])
    expect(transport.getRecoveryState?.().phase).toBe('ended')
    expect(transport.getPtyId()).toBeNull()
    transport.destroy?.()
  })

  it('settles on the exit cause a host without verdicts records', async () => {
    const onPtyExit = vi.fn()
    const transport = await attachRestoredHostTab(onPtyExit)
    answerShow({ connected: false, exitCause: { kind: 'operator_close' } })

    refuseStream('no_connected_pty')

    await vi.waitFor(() => expect(onPtyExit).toHaveBeenCalledWith(HOST_TAB_PTY_ID, undefined))
    expect(transport.getRecoveryState?.().phase).toBe('ended')
    transport.destroy?.()
  })

  it.each([
    ['an unverifiable verdict', { connected: false, verdict: 'unverifiable' }],
    [
      'a live verdict over a stale exit cause',
      { connected: true, verdict: 'live', exitCause: { kind: 'operator_close' } }
    ],
    [
      'a stop the host never saw land',
      { connected: false, exitCause: { kind: 'unknown', reason: 'stop_unverified' } }
    ],
    ['an older host without exit fields', { connected: false }]
  ])('keeps retrying on %s', async (_label, terminal) => {
    const onPtyExit = vi.fn()
    const transport = await attachRestoredHostTab(onPtyExit)
    const shown = answerShow(terminal)

    refuseStream('terminal_handle_stale')

    await vi.waitFor(() => expect(shown).toEqual(['terminal-ended']))
    await vi.waitFor(() =>
      expect(runtimeCall).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'session.tabs.list' })
      )
    )
    expect(onPtyExit).not.toHaveBeenCalled()
    expect(transport.getRecoveryState?.().phase).not.toBe('ended')
    expect(transport.getPtyId()).toBe(HOST_TAB_PTY_ID)
    transport.destroy?.()
  })

  it.each([
    ['a new handle', { handle: 'terminal-restarted' }],
    [
      'a new incarnation under the same handle',
      { handle: 'terminal-ended', incarnationId: 'inc-2' }
    ],
    ['a new PTY under the same handle', { handle: 'terminal-ended', ptyId: 'pty-2' }]
  ])('keeps a pane the host already replaced with %s', async (_label, replacement) => {
    const onPtyExit = vi.fn()
    const transport = await attachRestoredHostTab(onPtyExit)
    const shown = answerShow({
      connected: false,
      verdict: 'exited',
      ptyId: 'pty-1',
      incarnationId: 'inc-1'
    })
    const answer = runtimeCall.getMockImplementation()
    runtimeCall.mockImplementation(async (args: { method: string; params?: unknown }) =>
      args.method === 'terminal.resolvePane'
        ? {
            ok: true,
            result: {
              terminal: {
                tabId: 'host-tab-1',
                leafId: 'pane:1',
                worktreeId: 'wt-1',
                ptyId: 'pty-1',
                incarnationId: 'inc-1',
                ...replacement
              }
            }
          }
        : answer?.(args)
    )

    refuseStream('terminal_handle_stale')

    await vi.waitFor(() => expect(shown).toEqual(['terminal-ended']))
    // Why: let the probe's pane read answer; a premature retirement lands within these turns.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(onPtyExit).not.toHaveBeenCalled()
    expect(transport.getRecoveryState?.().phase).not.toBe('ended')
    transport.destroy?.()
  })

  it('leaves a stopped pane the host still publishes to be re-created on activation', async () => {
    const onPtyExit = vi.fn()
    const transport = await attachRestoredHostTab(onPtyExit)
    const shown = answerShow({ connected: false, exitCause: { kind: 'operator_close' } })
    const answer = runtimeCall.getMockImplementation()
    runtimeCall.mockImplementation(async (args: { method: string; params?: unknown }) =>
      args.method === 'session.tabs.list'
        ? {
            ok: true,
            result: {
              worktree: 'wt-1',
              publicationEpoch: 'epoch-ready',
              snapshotVersion: 3,
              activeGroupId: null,
              activeTabId: 'host-tab-1::pane:1',
              activeTabType: 'terminal',
              tabs: [
                {
                  type: 'terminal',
                  id: 'host-tab-1::pane:1',
                  parentTabId: 'host-tab-1',
                  leafId: 'pane:1',
                  title: 'Terminal',
                  isActive: true,
                  status: 'pending-handle',
                  terminal: null
                }
              ]
            }
          }
        : answer?.(args)
    )

    refuseStream('terminal_handle_stale')

    await vi.waitFor(() => expect(shown).toEqual(['terminal-ended']))
    // Why: let the probe's inventory read answer; a premature retirement lands within these turns.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(onPtyExit).not.toHaveBeenCalled()
    expect(transport.getRecoveryState?.().phase).not.toBe('ended')
    transport.destroy?.()
  })

  it('hands a settled pane back once a host snapshot publishes its new process', async () => {
    const onHostReboundExitedPty = vi.fn()
    const transport = await attachRestoredHostTab(vi.fn(), onHostReboundExitedPty)
    answerShow({ connected: false, verdict: 'exited', incarnationId: 'inc-1' })
    refuseStream('terminal_handle_stale')
    await vi.waitFor(() => expect(transport.getRecoveryState?.().phase).toBe('ended'))

    await publishHostSurface({ terminal: 'terminal-ended', incarnationId: 'inc-1' }, 4)
    await publishHostSurface({ terminal: 'terminal-ended' }, 5)
    await publishHostSurface(null, 6)
    expect(onHostReboundExitedPty).not.toHaveBeenCalled()

    await publishHostSurface({ terminal: 'terminal-ended', incarnationId: 'inc-2' }, 7)
    await publishHostSurface({ terminal: 'terminal-later' }, 8)
    expect(onHostReboundExitedPty.mock.calls).toEqual([['remote:hub-env@@terminal-ended']])
    transport.destroy?.()
  })

  it('hands a settled pane back to a new handle the host binds to it', async () => {
    const onHostReboundExitedPty = vi.fn()
    const transport = await attachRestoredHostTab(vi.fn(), onHostReboundExitedPty)
    answerShow({ connected: false, exitCause: { kind: 'operator_close' } })
    refuseStream('no_connected_pty')
    await vi.waitFor(() => expect(transport.getRecoveryState?.().phase).toBe('ended'))

    await publishHostSurface({ terminal: 'terminal-restarted' }, 4)

    expect(onHostReboundExitedPty.mock.calls).toEqual([['remote:hub-env@@terminal-restarted']])
    transport.destroy?.()
  })

  it('hands a settled pane back to a process the host published while the exit was confirming', async () => {
    const onHostReboundExitedPty = vi.fn()
    const transport = await attachRestoredHostTab(vi.fn(), onHostReboundExitedPty)
    answerShow({ connected: false, verdict: 'exited', incarnationId: 'inc-1' })
    let answerPane: (value: unknown) => void = () => {}
    const answer = runtimeCall.getMockImplementation()
    runtimeCall.mockImplementation(async (args: { method: string; params?: unknown }) =>
      args.method === 'terminal.resolvePane'
        ? new Promise((resolve) => {
            answerPane = resolve
          })
        : answer?.(args)
    )
    refuseStream('terminal_handle_stale')
    await vi.waitFor(() =>
      expect(runtimeCall).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'terminal.resolvePane' })
      )
    )

    await publishHostSurface({ terminal: 'terminal-ended', incarnationId: 'inc-2' }, 4)
    answerPane({
      ok: true,
      result: {
        terminal: {
          handle: 'terminal-ended',
          tabId: 'host-tab-1',
          leafId: 'pane:1',
          worktreeId: 'wt-1',
          incarnationId: 'inc-1'
        }
      }
    })

    await vi.waitFor(() =>
      expect(onHostReboundExitedPty.mock.calls).toEqual([['remote:hub-env@@terminal-ended']])
    )
    transport.destroy?.()
  })

  it('settles a pane whose restore attach is refused as stale before it binds', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onPtyExit = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1',
      onPtyExit
    })
    const shown: string[] = []
    let resolves = 0
    runtimeCall.mockImplementation(async (args: { method: string; params?: ShowParams }) => {
      if (args.method === 'terminal.resolvePane') {
        resolves += 1
        return resolves === 1
          ? { ok: false, error: { code: 'runtime_error', message: 'terminal_handle_stale' } }
          : {
              ok: true,
              result: {
                terminal: {
                  handle: 'terminal-ended',
                  tabId: 'tab-1',
                  leafId: 'pane:1',
                  worktreeId: 'wt-1'
                }
              }
            }
      }
      if (args.method === 'terminal.show') {
        shown.push(args.params?.terminal ?? '')
        return { ok: true, result: { terminal: { connected: false, verdict: 'exited' } } }
      }
      return { ok: true, result: {} }
    })

    transport.attach({ existingPtyId: 'remote:env-1@@terminal-ended', callbacks: {} })

    await vi.waitFor(() =>
      expect(onPtyExit).toHaveBeenCalledWith('remote:env-1@@terminal-ended', undefined)
    )
    expect(shown).toEqual(['terminal-ended'])
    expect(transport.getRecoveryState?.().phase).toBe('ended')
    expect(subscriptionSendBinary).not.toHaveBeenCalled()
    transport.destroy?.()
  })
  it.each(['source-notification', 'exit-effect', 'captured-disposer'] as const)(
    'keeps the early handoff after an adopted retirement throws in %s',
    async (site) => {
      const { getRemoteRuntimeTerminalMultiplexer } =
        await import('../../runtime/remote-runtime-terminal-multiplexer')
      const multiplexer = getRemoteRuntimeTerminalMultiplexer('hub-env')
      const subscribe = multiplexer.subscribeTerminal.bind(multiplexer)
      const closed = vi.fn()
      const interception = vi
        .spyOn(multiplexer, 'subscribeTerminal')
        .mockImplementation(async (args) => {
          const stream = await subscribe(args)
          const close = stream.close
          stream.close = () => {
            close()
            closed()
          }
          return stream
        })
      const rebound = vi.fn()
      const exit = vi.fn(() => {
        if (site === 'exit-effect') {
          throw new Error('exit effect failed')
        }
      })
      const transport = await attachRestoredHostTab(exit, rebound)
      const events = await import('../../runtime/web-session-terminal-handle-events')
      const subscribeHandle = events.subscribeAcceptedWebSessionTerminalHandle
      let firstDisposal = true
      const disposals = vi
        .spyOn(events, 'subscribeAcceptedWebSessionTerminalHandle')
        .mockImplementation((args, listener) => {
          const stop = subscribeHandle(args, listener)
          return () => {
            stop()
            if (site === 'captured-disposer' && firstDisposal) {
              firstDisposal = false
              throw new Error('captured observation disposal failed')
            }
          }
        })
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {
        if (site === 'source-notification') {
          throw new Error('warning failed')
        }
      })
      const observation = transport.observeInputSource?.({
        beforeChange: () => {},
        afterChange: (source) => {
          if (site === 'source-notification' && !source) {
            throw new Error('observer failed')
          }
        }
      })
      try {
        answerShow({ connected: false, verdict: 'exited', incarnationId: 'inc-1' })
        refuseStream('terminal_handle_stale')
        await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce())
        expect(closed).toHaveBeenCalledOnce()
        await publishHostSurface({ terminal: 'terminal-restarted', incarnationId: 'inc-2' }, 4)
        expect(rebound.mock.calls).toEqual([['remote:hub-env@@terminal-restarted']])
        expect(exit).toHaveBeenCalledOnce()
        expect(transport.getPtyId()).toBeNull()
        expect(events.getWebSessionTerminalHandleSubscriberCountForTests()).toBe(0)
      } finally {
        observation?.dispose()
        warning.mockRestore()
        interception.mockRestore()
        transport.destroy?.()
        disposals.mockRestore()
      }
    }
  )

  it.each([10, 100])(
    'bounds actual exit observation/rebind work and current bytes at N=%i',
    async (n) => {
      const events = await import('../../runtime/web-session-terminal-handle-events')
      const subscribe = events.subscribeAcceptedWebSessionTerminalHandle
      let registrations = 0
      let removals = 0
      let callbacks = 0
      const observation = vi
        .spyOn(events, 'subscribeAcceptedWebSessionTerminalHandle')
        .mockImplementation((args, listener) => {
          registrations++
          const stop = subscribe(args, (update) => {
            callbacks++
            listener(update)
          })
          return () => {
            removals++
            stop()
          }
        })
      const rebound = vi.fn()
      const exit = vi.fn()
      const transport = await attachRestoredHostTab(exit, rebound)
      try {
        answerShow({ connected: false, verdict: 'exited', incarnationId: 'inc-1' })
        for (let i = 0; i < n; i++) {
          if (i > 0) {
            const frames = subscribeFrameCount()
            transport.attach({ existingPtyId: HOST_TAB_PTY_ID, callbacks: {} })
            await vi.waitFor(() => expect(subscribeFrameCount()).toBeGreaterThan(frames), {
              interval: 1
            })
            emitSnapshot(latestSubscribePayload().streamId, 'live prompt')
          }
          const source = transport.getInputSource?.()
          expect(source?.isCurrent()).toBe(true)
          expect(transport.sendInput(`live-${i};`, 'driving')).toBe(true)
          await vi.waitFor(() => expect(inputFrameTexts().join('')).toContain(`live-${i};`), {
            interval: 1
          })
          refuseStream('terminal_handle_stale')
          await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(i + 1), { interval: 1 })
          expect(source?.isCurrent()).toBe(false)
          expect(events.getWebSessionTerminalHandleSubscriberCountForTests()).toBe(1)
          await publishHostSurface(
            { terminal: 'terminal-ended', incarnationId: 'inc-1' },
            4 + 2 * i
          )
          expect(rebound).toHaveBeenCalledTimes(i)
          await publishHostSurface(
            { terminal: 'terminal-restarted', incarnationId: 'inc-2' },
            5 + 2 * i
          )
          expect(rebound).toHaveBeenCalledTimes(i + 1)
          expect(events.getWebSessionTerminalHandleSubscriberCountForTests()).toBe(0)
        }
        expect(registrations).toBe(2 * n)
        expect(removals).toBe(2 * n)
        expect(callbacks).toBe(2 * n)
      } finally {
        transport.destroy?.()
        observation.mockRestore()
      }
      expect(events.getWebSessionTerminalHandleSubscriberCountForTests()).toBe(0)
    },
    30_000
  )

  it.each(['connect', 'attach', 'rebind', 'destroy'] as const)(
    'detaches the actual early observer and rejects late exit proof after %s',
    async (entry) => {
      const exit = vi.fn()
      const rebound = vi.fn()
      const transport = await attachRestoredHostTab(exit, rebound)
      const events = await import('../../runtime/web-session-terminal-handle-events')
      const answer = runtimeCall.getMockImplementation()
      let finishProof!: (value: unknown) => void
      runtimeCall.mockImplementation(async (request: { method: string }) => {
        if (request.method === 'terminal.show') {
          return new Promise((resolve) => {
            finishProof = resolve
          })
        }
        return answer?.(request)
      })
      try {
        refuseStream('terminal_handle_stale')
        await vi.waitFor(() => expect(finishProof).toBeTypeOf('function'))
        expect(events.getWebSessionTerminalHandleSubscriberCountForTests()).toBe(2)
        const frames = subscribeFrameCount()
        if (entry === 'destroy') {
          transport.destroy?.()
        } else if (entry === 'rebind') {
          resolvedPaneHandle = 'terminal-restarted'
          await publishHostSurface({ terminal: 'terminal-restarted', incarnationId: 'inc-2' }, 8)
          await vi.waitFor(() => expect(subscribeFrameCount()).toBeGreaterThan(frames))
          emitSnapshot(latestSubscribePayload().streamId, 'current process')
        } else {
          resolvedPaneHandle = 'terminal-restarted'
          if (entry === 'connect') {
            await transport.connect({ url: '', callbacks: {} })
          } else {
            transport.attach({ existingPtyId: 'remote:hub-env@@terminal-restarted', callbacks: {} })
          }
          await vi.waitFor(() => expect(subscribeFrameCount()).toBeGreaterThan(frames))
          emitSnapshot(latestSubscribePayload().streamId, 'current process')
        }
        expect(events.getWebSessionTerminalHandleSubscriberCountForTests()).toBe(0)
        finishProof({
          ok: true,
          result: {
            terminal: {
              handle: 'terminal-ended',
              connected: false,
              verdict: 'exited',
              incarnationId: 'inc-1'
            }
          }
        })
        await publishHostSurface({ terminal: 'terminal-too-late', incarnationId: 'inc-2' }, 9)
        expect(rebound).not.toHaveBeenCalled()
        if (entry !== 'destroy') {
          expect(exit).not.toHaveBeenCalled()
          expect(transport.getPtyId()).toBe('remote:hub-env@@terminal-restarted')
          expect(transport.sendInput('new-entry-positive', 'driving')).toBe(true)
          await vi.waitFor(() => expect(inputFrameTexts().join('')).toContain('new-entry-positive'))
        } else {
          expect(transport.sendInput('after-destroy', 'driving')).toBe(false)
        }
        expect(events.getWebSessionTerminalHandleSubscriberCountForTests()).toBe(0)
      } finally {
        finishProof?.({ ok: true, result: {} })
        transport.destroy?.()
      }
    }
  )

  it('cannot hand an outer retirement the successor installed during source publication', async () => {
    const exit = vi.fn()
    const rebound = vi.fn()
    const transport = await attachRestoredHostTab(exit, rebound)
    const events = await import('../../runtime/web-session-terminal-handle-events')
    const a = transport.getInputSource?.()
    const frames = subscribeFrameCount()
    let replaced = false
    const observation = transport.observeInputSource?.({
      beforeChange: () => {},
      afterChange: (source) => {
        if (!source && !replaced) {
          replaced = true
          resolvedPaneHandle = 'terminal-successor'
          transport.attach({ existingPtyId: 'remote:hub-env@@terminal-successor', callbacks: {} })
        }
      }
    })
    try {
      answerShow({ connected: false, verdict: 'exited', incarnationId: 'inc-1' })
      refuseStream('terminal_handle_stale')
      await vi.waitFor(() => expect(subscribeFrameCount()).toBeGreaterThan(frames))
      emitSnapshot(latestSubscribePayload().streamId, 'successor prompt')
      await publishHostSurface({ terminal: 'terminal-unrelated', incarnationId: 'inc-2' }, 9)
      expect(rebound).not.toHaveBeenCalled()
      expect(exit).not.toHaveBeenCalled()
      expect(a?.isCurrent()).toBe(false)
      expect(transport.getPtyId()).toBe('remote:hub-env@@terminal-successor')
      expect(transport.sendInput('successor-positive', 'driving')).toBe(true)
      await vi.waitFor(() => expect(inputFrameTexts().join('')).toContain('successor-positive'))
      expect(events.getWebSessionTerminalHandleSubscriberCountForTests()).toBe(0)
    } finally {
      observation?.dispose()
      transport.destroy?.()
    }
  })

  it('keeps watching-finally priority over waiting faults through actual published rebind delivery', async () => {
    const transport = await attachRestoredHostTab(vi.fn(), vi.fn())
    const original = transport.getInputSource?.()
    const events = await import('../../runtime/web-session-terminal-handle-events')
    const subscribe = events.subscribeAcceptedWebSessionTerminalHandle
    const removals: number[] = []
    let registrations = 0
    let failed = false
    let failure: unknown
    const observation = vi
      .spyOn(events, 'subscribeAcceptedWebSessionTerminalHandle')
      .mockImplementation((args, listener) => {
        const registration = ++registrations
        const stop = subscribe(args, (update) => {
          try {
            listener(update)
          } catch (error) {
            failed = true
            failure = error
          }
        })
        return () => {
          stop()
          removals.push(registration)
          if (registration === 1) {
            throw new Error('waiting fault after real removal')
          }
          if (registration === 2) {
            throw undefined
          }
        }
      })
    const { promise: show, resolve: finishShow } = Promise.withResolvers<void>()
    const defaultCall = runtimeCall.getMockImplementation()
    runtimeCall.mockImplementation(async (args: { method: string }) => {
      if (args.method === 'terminal.show') {
        await show
        return { ok: true, result: { terminal: { connected: true } } }
      }
      return defaultCall?.(args)
    })
    try {
      refuseStream('terminal_handle_stale')
      await vi.waitFor(() => expect(registrations).toBe(2))
      expect(events.getWebSessionTerminalHandleSubscriberCountForTests()).toBe(2)
      await publishHostSurface({ terminal: 'terminal-new' }, 9)
      expect(failed).toBe(true)
      expect(failure).toBeUndefined()
      expect(removals).toEqual([1, 2])
      expect(events.getWebSessionTerminalHandleSubscriberCountForTests()).toBe(0)
      expect(transport.getInputSource?.()).toBe(original)
      expect(transport.getPtyId()).toBe(HOST_TAB_PTY_ID)
      observation.mockRestore()
      finishShow()
      resolvedPaneHandle = 'terminal-new'
      const frames = subscribeFrameCount()
      transport.attach({ existingPtyId: 'remote:hub-env@@terminal-new', callbacks: {} })
      await vi.waitFor(() => expect(subscribeFrameCount()).toBeGreaterThan(frames))
      emitSnapshot(latestSubscribePayload().streamId, 'new prompt')
      expect(transport.sendInput('after-captured-cleanup', 'driving')).toBe(true)
      await vi.waitFor(() => expect(inputFrameTexts().join('')).toContain('after-captured-cleanup'))
      expect(original?.isCurrent()).toBe(false)
    } finally {
      observation.mockRestore()
      finishShow()
      transport.destroy?.()
    }
    expect(events.getWebSessionTerminalHandleSubscriberCountForTests()).toBe(0)
  })
})
