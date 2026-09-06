// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { StrictMode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { OmpRpcChatSendBehavior } from '../../../../shared/omp-rpc-chat-ipc-contract'
import { isOmpRpcExecutableCommand, ompRpcExecutableCommands } from './omp-rpc-command-catalog'
import { useOmpRpcCommandSend, type UseOmpRpcCommandSendArgs } from './use-omp-rpc-command-send'

type CommandSendArgs = Parameters<UseOmpRpcCommandSendArgs['sendChat']>[0]

/** Stands in for sendOmpRpcChatPane on the path where its gates admit the send:
 *  the capture slot is claimed from inside that gate, never by the hook. */
function authorizingSend<T>(impl: (args: CommandSendArgs) => Promise<T>) {
  return vi.fn((args: CommandSendArgs) => {
    args.onAuthorized?.()
    return impl(args)
  })
}

const CATALOG = ompRpcExecutableCommands([
  { name: 'help' },
  { name: 'model' },
  { name: 'rename' },
  { name: 'retry' }
])

function renderSend(overrides: Partial<Parameters<typeof useOmpRpcCommandSend>[0]> = {}) {
  const sendChat = authorizingSend(async () => ({ ok: true as const, agentInvoked: false }))
  const onSlashCommand = vi.fn()
  const onCommandDispatched = vi.fn()
  const onSendFailed = vi.fn()
  const onCommandFailed = vi.fn()
  const onCommandAgentInvoked = vi.fn()
  const hook = renderHook(
    (props: Partial<Parameters<typeof useOmpRpcCommandSend>[0]>) =>
      useOmpRpcCommandSend({
        agent: 'omp',
        isRpcOwned: true,
        executableCommands: CATALOG,
        sessionGeneration: 1,
        commandQueueKey: 'pane-1:1',
        sendChat,
        onSlashCommand,
        onCommandDispatched,
        onSendFailed,
        onCommandFailed,
        onCommandAgentInvoked,
        ...overrides,
        ...props
      }),
    { initialProps: {} }
  )
  return {
    hook,
    sendChat,
    onSlashCommand,
    onCommandDispatched,
    onSendFailed,
    onCommandFailed,
    onCommandAgentInvoked
  }
}

describe('useOmpRpcCommandSend', () => {
  it('claims a catalog command on an owned pane and sends it as a `command`', async () => {
    const { hook, sendChat, onSlashCommand, onCommandDispatched } = renderSend()

    let claimed = false
    await act(async () => {
      claimed = hook.result.current('/help')
    })

    expect(claimed).toBe(true)
    // `command` forces the `prompt` verb: it is the ONLY verb OMP runs builtin
    // and skill slash commands through — steer/follow_up pass text to the model.
    // The run id doubles as the wire request id, so this command's later
    // prompt_result can be told apart from any other run's.
    const commandRunId = onCommandDispatched.mock.calls[0]?.[0] as string
    expect(sendChat).toHaveBeenCalledWith({
      message: '/help',
      behavior: 'command',
      requestId: commandRunId,
      expectedGeneration: 1,
      onAuthorized: expect.any(Function)
    })
    // The reducer must retire the previous command's output before frames land,
    // under an id that correlates this run's frames and response with the slot.
    expect(onCommandDispatched).toHaveBeenCalledTimes(1)
    expect(onCommandDispatched).toHaveBeenCalledWith(expect.any(String))
    expect(onSlashCommand).toHaveBeenCalledWith('/help')
  })

  it('sends the same `command` behavior while a turn is streaming', async () => {
    const { hook, sendChat } = renderSend()

    await act(async () => {
      hook.result.current('/model opus')
    })

    expect(sendChat).toHaveBeenCalledWith({
      message: '/model opus',
      behavior: 'command',
      requestId: expect.any(String),
      expectedGeneration: 1,
      onAuthorized: expect.any(Function)
    })
  })

  it('declines everything the route resolver does not send to the session', () => {
    const cases = [
      { args: { isRpcOwned: false }, text: '/help' },
      { args: { agent: 'claude' as const }, text: '/help' },
      // `/usage` is absent from this catalog, so the probe still owns it.
      { args: {}, text: '/usage' },
      // An unpublished catalog proves nothing, so nothing may route here.
      { args: { executableCommands: null }, text: '/help' },
      // Plain chat is the chat send path's job, not this one's.
      { args: {}, text: 'what changed here?' },
      { args: {}, text: '   ' }
    ]
    for (const { args, text } of cases) {
      const { hook, sendChat } = renderSend(args)
      expect(hook.result.current(text)).toBe(false)
      expect(sendChat).not.toHaveBeenCalled()
    }
  })

  it('reports a failed round trip instead of silently claiming the draft', async () => {
    const sendChat = vi.fn(async () => ({ ok: false as const, reason: 'transport closed' }))
    const { hook, onSendFailed, onSlashCommand } = renderSend({ sendChat })

    await act(async () => {
      hook.result.current('/help')
    })

    expect(onSendFailed).toHaveBeenCalledTimes(1)
    expect(onSlashCommand).not.toHaveBeenCalled()
  })

  it('records the captured output as the marker outcome once the command settles', async () => {
    const sendChat = authorizingSend(async () => ({ ok: true as const, agentInvoked: false }))
    const { hook, onSlashCommand } = renderSend({ sendChat })

    await act(async () => {
      hook.result.current('/rename parity')
    })

    // agentInvoked rides through so the marker can say "agent not invoked";
    // the command's text output arrives as frames on the pane subscription.
    expect(onSlashCommand).toHaveBeenCalledWith('/rename parity')
  })

  it('declines a command OMP omits from its RPC catalog', () => {
    // /clear has no text-mode handler upstream, so it is absent from the
    // catalog and sending it as a prompt would fall through to the model.
    const { hook, sendChat } = renderSend({
      executableCommands: ompRpcExecutableCommands([{ name: 'help' }])
    })

    expect(hook.result.current('/clear')).toBe(false)
    expect(sendChat).not.toHaveBeenCalled()
  })

  it('reports the response agentInvoked flag, the only signal for a consumed builtin', async () => {
    // rpc-mode.ts returns { agentInvoked } on the correlated prompt response and
    // emits NO prompt_result frame for a consumed builtin such as /retry, so the
    // reducer's suppression can only be driven from here.
    const sendChat = authorizingSend(async () => ({ ok: true as const, agentInvoked: true }))
    const { hook, onCommandAgentInvoked, onCommandDispatched } = renderSend({ sendChat })

    await act(async () => {
      hook.result.current('/retry')
    })

    expect(onCommandAgentInvoked).toHaveBeenCalledTimes(1)
    // Same run id as the dispatch, so the reducer can reject a stale report.
    expect(onCommandAgentInvoked).toHaveBeenCalledWith(onCommandDispatched.mock.calls[0]?.[0])
  })

  it('leaves the captured output renderable when the command invoked no agent', async () => {
    const { hook, onCommandAgentInvoked } = renderSend()

    await act(async () => {
      hook.result.current('/help')
    })

    expect(onCommandAgentInvoked).not.toHaveBeenCalled()
  })

  it('never reports agentInvoked for a failed round trip', async () => {
    const sendChat = vi.fn(async () => ({ ok: false as const, reason: 'transport closed' }))
    const { hook, onCommandAgentInvoked } = renderSend({ sendChat })

    await act(async () => {
      hook.result.current('/help')
    })

    expect(onCommandAgentInvoked).not.toHaveBeenCalled()
  })

  it('serialises overlapping session commands so their captured output cannot merge', async () => {
    // Two commands share one uncorrelated output slot on the wire, so the
    // second must not begin until the first has settled.
    const settle: ((value: { ok: true; agentInvoked: boolean }) => void)[] = []
    const sendChat = authorizingSend(
      () =>
        new Promise<{ ok: true; agentInvoked: boolean }>((resolve) => {
          settle.push(resolve)
        })
    )
    const { hook, onCommandDispatched, onSlashCommand } = renderSend({ sendChat })

    act(() => {
      expect(hook.result.current('/retry')).toBe(true)
      expect(hook.result.current('/help')).toBe(true)
    })

    expect(sendChat).toHaveBeenCalledTimes(1)
    expect(onCommandDispatched).toHaveBeenCalledTimes(1)

    await act(async () => {
      settle[0]?.({ ok: true, agentInvoked: true })
    })

    expect(sendChat).toHaveBeenCalledTimes(2)
    // /help's own dispatch retires /retry's slot only now, under its own id,
    // and that id is what /help's prompt is correlated under on the wire.
    expect(onCommandDispatched).toHaveBeenCalledTimes(2)
    expect(onCommandDispatched.mock.calls[1]?.[0]).not.toBe(onCommandDispatched.mock.calls[0]?.[0])
    expect(sendChat).toHaveBeenLastCalledWith({
      message: '/help',
      behavior: 'command',
      requestId: onCommandDispatched.mock.calls[1]?.[0],
      expectedGeneration: 1,
      onAuthorized: expect.any(Function)
    })

    await act(async () => {
      settle[1]?.({ ok: true, agentInvoked: false })
    })

    expect(onSlashCommand).toHaveBeenNthCalledWith(1, '/retry')
    expect(onSlashCommand).toHaveBeenNthCalledWith(2, '/help')
  })

  it('keeps the session command boundary across a Chat view remount', async () => {
    // The terminal-pane-owned RPC session outlives a Chat <-> Terminal toggle.
    // A second hook instance must therefore join the first instance's queue.
    const settle: ((value: { ok: true; agentInvoked: boolean }) => void)[] = []
    const sendChat = authorizingSend(
      () =>
        new Promise<{ ok: true; agentInvoked: boolean }>((resolve) => {
          settle.push(resolve)
        })
    )
    const first = renderSend({ sendChat })

    act(() => {
      expect(first.hook.result.current('/retry')).toBe(true)
    })
    const remounted = renderSend({ sendChat })

    act(() => {
      expect(remounted.hook.result.current('/help')).toBe(true)
    })

    expect(sendChat).toHaveBeenCalledTimes(1)

    await act(async () => {
      settle[0]?.({ ok: true, agentInvoked: true })
    })

    expect(sendChat).toHaveBeenCalledTimes(2)
    await act(async () => {
      settle[1]?.({ ok: true, agentInvoked: false })
    })
  })

  it('correlates every run under its own wire request id', async () => {
    // OMP echoes the request id on the command's later prompt_result frame
    // (rpc-mode.ts:152-156 -> `id: input.id`), and that frame is the only
    // authoritative word that no agent ran. Reusing the capture-slot id as the
    // wire id is what lets the reducer bind the two BEFORE the frame can land:
    // the slot is claimed in the same tick as the send, so there is no window
    // in which an uncorrelated report could be applied to the wrong run.
    const sendChat = authorizingSend(async (_args: CommandSendArgs) => ({
      ok: true as const,
      agentInvoked: false
    }))
    const { hook, onCommandDispatched } = renderSend({ sendChat })

    await act(async () => {
      hook.result.current('/help')
    })
    await act(async () => {
      hook.result.current('/model opus')
    })

    const ids = onCommandDispatched.mock.calls.map(([id]) => id)
    expect(new Set(ids).size).toBe(2)
    expect(sendChat.mock.calls.map(([args]) => args.requestId)).toEqual(ids)
  })

  it('drops a completion whose ownership generation is no longer current', async () => {
    // The pane rebound to a new RPC session while /retry was in flight; its
    // late completion must not touch the new session's marker or turn state.
    let settle: ((value: { ok: true; agentInvoked: boolean }) => void) | undefined
    const sendChat = authorizingSend(
      () =>
        new Promise<{ ok: true; agentInvoked: boolean }>((resolve) => {
          settle = resolve
        })
    )
    const { hook, onSlashCommand, onCommandAgentInvoked } = renderSend({ sendChat })

    act(() => {
      hook.result.current('/retry')
    })
    hook.rerender({ sessionGeneration: 2 })

    await act(async () => {
      settle?.({ ok: true, agentInvoked: true })
    })

    expect(onCommandAgentInvoked).not.toHaveBeenCalled()
    expect(onSlashCommand).not.toHaveBeenCalled()
  })

  it('surfaces a command DECLINED after a rebind in the composer that is still mounted', async () => {
    // The generation check exists to suppress a stale session's SUCCESS side
    // effects, and a declined send is not one — the draft is already gone.
    // Handing it to the durable route instead is a guaranteed discard: that
    // reporter drops every report whose generation is not the row's current
    // one. The composer never unmounted, so it is the surface that must say so.
    let settle: ((value: { ok: false; reason: string }) => void) | undefined
    const sendChat = vi.fn(
      () =>
        new Promise<{ ok: false; reason: string }>((resolve) => {
          settle = resolve
        })
    )
    const { hook, onSendFailed, onCommandFailed, onSlashCommand } = renderSend({
      sendChat,
      commandQueueKey: 'pane-rebind-failure:1'
    })

    act(() => {
      hook.result.current('/help')
    })
    hook.rerender({ sessionGeneration: 2 })

    await act(async () => {
      settle?.({ ok: false, reason: 'session superseded' })
    })

    expect(onSendFailed).toHaveBeenCalledTimes(1)
    expect(onCommandFailed).not.toHaveBeenCalled()
    expect(onSlashCommand).not.toHaveBeenCalled()
  })

  it("keeps reporting locally across StrictMode's effect replay", async () => {
    // StrictMode runs setup -> cleanup -> setup on mount. A mounted flag armed
    // only at declaration stays false after that replay, which would route a
    // visible composer's failure to the durable pane notice it then replays.
    const sendChat = vi.fn(() => Promise.reject(new Error('handler torn down')))
    const onSendFailed = vi.fn()
    const onCommandFailed = vi.fn()
    const hook = renderHook(
      () =>
        useOmpRpcCommandSend({
          agent: 'omp',
          isRpcOwned: true,
          executableCommands: CATALOG,
          sessionGeneration: 1,
          commandQueueKey: 'pane-strict-mode:1',
          sendChat,
          onSendFailed,
          onCommandFailed
        }),
      { wrapper: StrictMode }
    )

    await act(async () => {
      hook.result.current('/help')
    })

    expect(onSendFailed).toHaveBeenCalledTimes(1)
    expect(onCommandFailed).not.toHaveBeenCalled()
  })

  it('reports a rejected round trip instead of leaving an unhandled rejection', async () => {
    const sendChat = vi.fn(() => Promise.reject(new Error('handler torn down')))
    const { hook, onSendFailed, onSlashCommand } = renderSend({ sendChat })

    await act(async () => {
      hook.result.current('/help')
    })

    expect(onSendFailed).toHaveBeenCalledTimes(1)
    expect(onSlashCommand).not.toHaveBeenCalled()
  })

  it('keeps the queue usable when a completion callback throws', async () => {
    // The completion callbacks are store dispatches. If one throws, the
    // serialisation chain must still settle: a rejected promise left as the
    // queue head is one no later command can chain off, which would kill
    // every slash command on the pane for the rest of its life.
    const onSlashCommand = vi.fn().mockImplementationOnce(() => {
      throw new Error('store dispatch failed')
    })
    const { hook, sendChat } = renderSend({ onSlashCommand })

    await act(async () => {
      hook.result.current('/retry')
    })
    await act(async () => {
      hook.result.current('/help')
    })

    expect(sendChat).toHaveBeenCalledTimes(2)
    expect(onSlashCommand).toHaveBeenNthCalledWith(2, '/help')
  })

  it('surfaces a queued command the pane rebound away from while the composer stays mounted', async () => {
    // The draft was already claimed, so a queued run abandoned because the pane
    // rebound cannot just vanish: nothing was sent, and on an owned pane there
    // is no PTY left for the user to retype it into. The durable route would
    // drop it — its generation is by construction no longer the row's — so the
    // still-mounted composer is where it has to land.
    let settle: ((value: { ok: true; agentInvoked: boolean }) => void) | undefined
    const sendChat = authorizingSend(
      () =>
        new Promise<{ ok: true; agentInvoked: boolean }>((resolve) => {
          settle = resolve
        })
    )
    const { hook, onSendFailed, onCommandFailed, onCommandDispatched } = renderSend({ sendChat })

    act(() => {
      expect(hook.result.current('/retry')).toBe(true)
      expect(hook.result.current('/help')).toBe(true)
    })
    expect(sendChat).toHaveBeenCalledTimes(1)

    hook.rerender({ sessionGeneration: 2 })
    await act(async () => {
      settle?.({ ok: true, agentInvoked: false })
    })

    // /help never reached the wire and never claimed a capture slot.
    expect(sendChat).toHaveBeenCalledTimes(1)
    expect(onCommandDispatched).toHaveBeenCalledTimes(1)
    expect(onSendFailed).toHaveBeenCalledTimes(1)
    expect(onCommandFailed).not.toHaveBeenCalled()
  })

  it('refuses a queued command the catalog stopped publishing before the queue reached it', async () => {
    // OMP republishes `available_commands_update` whenever command metadata
    // changes, and that never bumps the generation — so the rebind gate cannot
    // see a command that was executable when it was claimed and is not when it
    // dequeues. Sending it would reach `prompt` with no lookup to resolve it,
    // landing the user's command as chat text.
    let settle: ((value: { ok: true; agentInvoked: boolean }) => void) | undefined
    const sendChat = authorizingSend(
      () =>
        new Promise<{ ok: true; agentInvoked: boolean }>((resolve) => {
          settle = resolve
        })
    )
    const { hook, onSendFailed, onCommandDispatched, onSlashCommand } = renderSend({
      sendChat,
      commandQueueKey: 'pane-catalog-shrink:1'
    })

    act(() => {
      expect(hook.result.current('/retry')).toBe(true)
      expect(hook.result.current('/help')).toBe(true)
    })
    expect(sendChat).toHaveBeenCalledTimes(1)

    hook.rerender({ executableCommands: ompRpcExecutableCommands([{ name: 'retry' }]) })
    await act(async () => {
      settle?.({ ok: true, agentInvoked: false })
    })

    // /help never reached the wire and never claimed a capture slot, and the
    // draft it already consumed is reported rather than dropped.
    expect(sendChat).toHaveBeenCalledTimes(1)
    expect(onCommandDispatched).toHaveBeenCalledTimes(1)
    expect(onSlashCommand).not.toHaveBeenCalledWith('/help')
    expect(onSendFailed).toHaveBeenCalledTimes(1)
  })

  it('claims the capture slot only once the send gate authorises the command', async () => {
    // The hook's catalog ref stops tracking `available_commands_update` the
    // moment its Chat surface unmounts, so a queued command the store will
    // refuse still passes the hook's own recheck. Claiming the shared capture
    // slot before that authoritative answer would retire the PRECEDING
    // command's output on behalf of a command that never reached the wire.
    const liveCatalog = { current: CATALOG }
    const settle: ((value: { ok: true; agentInvoked: boolean }) => void)[] = []
    // Stands in for sendOmpRpcChatPane: the slot is claimed inside the gate.
    const sendChat = vi.fn((args: CommandSendArgs) => {
      if (!isOmpRpcExecutableCommand(args.message, liveCatalog.current)) {
        return Promise.resolve({
          ok: false as const,
          reason: 'the RPC session no longer publishes this command'
        })
      }
      args.onAuthorized?.()
      return new Promise<{ ok: true; agentInvoked: boolean }>((resolve) => {
        settle.push(resolve)
      })
    })
    const { hook, onCommandDispatched, onCommandFailed, onSlashCommand } = renderSend({
      sendChat,
      commandQueueKey: 'pane-gate-claim:1'
    })

    act(() => {
      expect(hook.result.current('/retry')).toBe(true)
      expect(hook.result.current('/help')).toBe(true)
    })
    expect(onCommandDispatched).toHaveBeenCalledTimes(1)

    hook.unmount()
    liveCatalog.current = ompRpcExecutableCommands([{ name: 'retry' }])

    await act(async () => {
      settle[0]?.({ ok: true, agentInvoked: false })
    })

    expect(sendChat).toHaveBeenCalledTimes(2)
    // /retry's captured output still owns the slot, and /help is reported.
    expect(onCommandDispatched).toHaveBeenCalledExactlyOnceWith(
      sendChat.mock.calls[0]?.[0]?.requestId
    )
    expect(onSlashCommand).not.toHaveBeenCalledWith('/help')
    expect(onCommandFailed).toHaveBeenCalledExactlyOnceWith('/help', 1)
  })

  it('pins every send to the generation it was dispatched on, so an unmounted hook cannot leak into a rebound session', async () => {
    // The ref mirroring the live generation stops updating the moment the Chat
    // view unmounts, so a command still queued behind an in-flight one would
    // pass its own staleness check and reach a session it never belonged to.
    // Carrying the dispatch generation on the send itself moves that decision
    // to the store, which still sees the rebind.
    const settle: ((value: { ok: true; agentInvoked: boolean }) => void)[] = []
    const sendChat = vi.fn<
      (args: {
        message: string
        behavior: OmpRpcChatSendBehavior
        requestId?: string
        expectedGeneration?: number
      }) => Promise<{ ok: true; agentInvoked: boolean }>
    >(
      () =>
        new Promise<{ ok: true; agentInvoked: boolean }>((resolve) => {
          settle.push(resolve)
        })
    )
    // Its own queue key: an undrained chain is module-level state that would
    // otherwise stall every later command on a shared key.
    const { hook } = renderSend({ sendChat, commandQueueKey: 'pane-unmount:1' })

    act(() => {
      expect(hook.result.current('/retry')).toBe(true)
      expect(hook.result.current('/help')).toBe(true)
    })
    expect(sendChat).toHaveBeenCalledTimes(1)

    // Toggling away from Chat unmounts the hook; the pane can still rebind.
    hook.unmount()
    await act(async () => {
      settle[0]?.({ ok: true, agentInvoked: false })
    })

    expect(sendChat).toHaveBeenCalledTimes(2)
    expect(sendChat.mock.calls.map(([args]) => args.expectedGeneration)).toEqual([1, 1])

    await act(async () => {
      settle[1]?.({ ok: true, agentInvoked: false })
    })
  })

  it('records a rejected queued command as durable command feedback after its hook unmounts', async () => {
    let settle: ((value: { ok: true; agentInvoked: boolean }) => void) | undefined
    const sendChat = vi
      .fn<() => Promise<{ ok: true; agentInvoked: boolean } | { ok: false; reason: string }>>()
      .mockImplementationOnce(
        () =>
          new Promise<{ ok: true; agentInvoked: boolean }>((resolve) => {
            settle = resolve
          })
      )
      .mockResolvedValueOnce({ ok: false, reason: 'session replaced' })
    const { hook, onSendFailed, onCommandFailed, onSlashCommand } = renderSend({
      sendChat,
      commandQueueKey: 'pane-unmount-failure:1'
    })

    act(() => {
      expect(hook.result.current('/retry')).toBe(true)
      expect(hook.result.current('/help')).toBe(true)
    })
    hook.unmount()

    await act(async () => {
      settle?.({ ok: true, agentInvoked: false })
    })

    expect(onSendFailed).not.toHaveBeenCalled()
    expect(onSlashCommand).not.toHaveBeenCalledWith('/help')
    expect(onCommandFailed).toHaveBeenCalledExactlyOnceWith('/help', 1)
  })

  it('records a REJECTED command as durable command feedback after its hook unmounts', async () => {
    // A resolved `{ ok: false }` and a rejected round trip cost the draft
    // identically, but they arrive from different layers: the first is main
    // declining the send, the second is the IPC round trip itself dying
    // (handler teardown, destroyed window). Only the first was durable, so a
    // rejection that settled after a Chat <-> Terminal toggle vanished into an
    // unmounted `setNotice`.
    let reject: ((reason: Error) => void) | undefined
    const sendChat = vi.fn<() => Promise<{ ok: true; agentInvoked: boolean }>>(
      () =>
        new Promise<{ ok: true; agentInvoked: boolean }>((_resolve, rejectSend) => {
          reject = rejectSend
        })
    )
    const { hook, onSendFailed, onCommandFailed, onSlashCommand } = renderSend({
      sendChat,
      commandQueueKey: 'pane-unmount-rejection:1'
    })

    act(() => {
      expect(hook.result.current('/help')).toBe(true)
    })
    hook.unmount()

    await act(async () => {
      reject?.(new Error('handler torn down'))
    })

    expect(onSlashCommand).not.toHaveBeenCalled()
    expect(onSendFailed).not.toHaveBeenCalled()
    expect(onCommandFailed).toHaveBeenCalledExactlyOnceWith('/help', 1)
  })

  it('records a queued command abandoned by a rebind as durable feedback once its hook unmounts', async () => {
    // The rebind lands while Chat is still mounted (so the generation ref does
    // see it), but the queued run only drains after the toggle unmounted the
    // hook. Nothing was sent and the draft is already consumed, so this has to
    // reach the pane owner rather than a dead local notice.
    let settle: ((value: { ok: true; agentInvoked: boolean }) => void) | undefined
    const sendChat = authorizingSend(
      () =>
        new Promise<{ ok: true; agentInvoked: boolean }>((resolve) => {
          settle = resolve
        })
    )
    const { hook, onSendFailed, onCommandFailed, onCommandDispatched } = renderSend({
      sendChat,
      commandQueueKey: 'pane-unmount-abandon:1'
    })

    act(() => {
      expect(hook.result.current('/retry')).toBe(true)
      expect(hook.result.current('/help')).toBe(true)
    })
    hook.rerender({ sessionGeneration: 2 })
    hook.unmount()

    await act(async () => {
      settle?.({ ok: true, agentInvoked: false })
    })

    // /help never reached the wire and never claimed a capture slot.
    expect(sendChat).toHaveBeenCalledTimes(1)
    expect(onCommandDispatched).toHaveBeenCalledTimes(1)
    expect(onSendFailed).not.toHaveBeenCalled()
    expect(onCommandFailed).toHaveBeenCalledExactlyOnceWith('/help', 1)
  })

  it('still reports a rejected command locally while the composer is mounted', async () => {
    // The durable path is the unmounted fallback, not a replacement: a mounted
    // composer keeps showing the failure inline and must not also write a
    // pane-owned notice its own remount would then replay.
    const sendChat = vi.fn(() => Promise.reject(new Error('handler torn down')))
    const { hook, onSendFailed, onCommandFailed } = renderSend({
      sendChat,
      commandQueueKey: 'pane-mounted-rejection:1'
    })

    await act(async () => {
      hook.result.current('/help')
    })

    expect(onSendFailed).toHaveBeenCalledTimes(1)
    expect(onCommandFailed).not.toHaveBeenCalled()
  })

  it('surfaces a command superseded mid-flight in the composer that is still mounted', async () => {
    // Same rule as the message path: a report carrying a superseded generation
    // can never pass the durable reporter's fence, so sending it there loses
    // the failure outright. The rebind needs no unmount, and the command's
    // consumed draft has no PTY to fall back into, so the mounted composer
    // reports it.
    let reject: ((error: Error) => void) | undefined
    const sendChat = authorizingSend(
      () =>
        new Promise<never>((_resolve, settle) => {
          reject = settle
        })
    )
    const { hook, onSendFailed, onCommandFailed } = renderSend({
      sendChat,
      commandQueueKey: 'pane-mounted-rebind:1'
    })

    act(() => {
      expect(hook.result.current('/help')).toBe(true)
    })
    // Rebound to a replacement session, but never unmounted.
    hook.rerender({ sessionGeneration: 2 })

    await act(async () => {
      reject?.(new Error('handler torn down'))
    })

    expect(onSendFailed).toHaveBeenCalledTimes(1)
    expect(onCommandFailed).not.toHaveBeenCalled()
  })

  it('keeps the queue moving after a rejected command', async () => {
    const sendChat = vi
      .fn<() => Promise<{ ok: true; agentInvoked: boolean }>>()
      .mockRejectedValueOnce(new Error('handler torn down'))
      .mockResolvedValue({ ok: true, agentInvoked: false })
    const { hook, onSlashCommand } = renderSend({ sendChat })

    await act(async () => {
      hook.result.current('/retry')
      hook.result.current('/help')
    })

    expect(sendChat).toHaveBeenCalledTimes(2)
    expect(onSlashCommand).toHaveBeenCalledExactlyOnceWith('/help')
  })
})
