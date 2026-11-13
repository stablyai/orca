import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { forgetTerminalNoteDraft } from './active-agent-terminal-send-lane'
import {
  admitTerminalNoticeLifetime,
  retireTerminalNoticeLifetime
} from '@/components/terminal-pane/provider-notices/terminal-notice-lifetime'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import {
  sendPromptWithGuardedPasteAndEnter,
  sendPromptWithLegacyCombinedSend
} from './active-agent-note-send-delivery'

const { callRuntimeRpc } = vi.hoisted(() => ({ callRuntimeRpc: vi.fn() }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc }))
vi.mock('../paste/agent-paste-draft', () => ({}))

type RpcParams = {
  terminal: string
  text?: string
  enter?: boolean
  expectInputGeneration?: number
}
type Step = 'status' | 'paste' | 'enter' | 'combined'
type Reply = () => unknown

const LOCAL: RuntimeClientTarget = { kind: 'local' }
const READY = { agentStatus: { isRunningAgent: true, status: 'idle' } }
const guarded = { allowLegacyFallback: false, ptyId: 'pty-test' }

let log: string[]
/** Replies queued per `handle step`; an unqueued step gets its ordinary accepted answer. */
let replies: Map<string, Reply[]>

function queue(handle: string, step: Step, ...answers: Reply[]): void {
  replies.set(`${handle} ${step}`, answers)
}

function accepted(
  handle: string,
  submitDelayMs?: unknown,
  inputGeneration?: number
): { send: Record<string, unknown> } {
  return {
    send: {
      handle,
      accepted: true,
      bytesWritten: 1,
      ...(submitDelayMs === undefined ? {} : { submitDelayMs }),
      ...(inputGeneration === undefined ? {} : { inputGeneration })
    }
  }
}

/** The host's status answer when the terminal's last input is `inputGeneration`. */
function readyAt(inputGeneration: number): Reply {
  return () => ({ ...READY, inputGeneration, resolvedInputGeneration: inputGeneration })
}

/** Params of every `terminal.send` issued so far for `step`. */
function sent(step: 'paste' | 'enter'): RpcParams[] {
  return callRuntimeRpc.mock.calls
    .filter(([, method]) => method === 'terminal.send')
    .map(([, , params]): RpcParams => params)
    .filter((params) => (step === 'paste' ? !!params.text : !params.text))
}

function rpcError(code: string): Error {
  return Object.assign(new Error(code), { code })
}

function deferred(): { promise: Promise<unknown>; resolve: (value: unknown) => void } {
  let resolve: (value: unknown) => void = () => {}
  const promise = new Promise<unknown>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.useFakeTimers()
  log = []
  replies = new Map()
  callRuntimeRpc.mockImplementation(
    async (target: RuntimeClientTarget, method: string, params: RpcParams) => {
      const step: Step =
        method === 'terminal.agentStatus'
          ? 'status'
          : params.text && params.enter
            ? 'combined'
            : params.text
              ? 'paste'
              : 'enter'
      const runtime = target.kind === 'environment' ? `${target.environmentId}/` : ''
      log.push(`${runtime}${params.terminal} ${step}`)
      const queued = replies.get(`${params.terminal} ${step}`)?.shift()
      if (queued) {
        return queued()
      }
      return step === 'status' ? READY : accepted(params.terminal)
    }
  )
})

afterEach(() => {
  forgetTerminalNoteDraft('pty-test')
  vi.useRealTimers()
  callRuntimeRpc.mockReset()
})

describe('guarded paste then Enter', () => {
  it('sends no Enter after a refused paste', async () => {
    queue('term_1', 'paste', () => ({
      send: { handle: 'term_1', accepted: false, bytesWritten: 0, refusedReason: 'permission' }
    }))
    const sending = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_1', 'note', guarded)
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(sending).resolves.toEqual({
      status: 'permission',
      code: 'terminal-send-permission'
    })
    expect(log).toEqual(['term_1 status', 'term_1 paste'])
  })

  it('sends no Enter after a paste with no answer, and lets the next send through', async () => {
    queue('term_1', 'paste', () => Promise.reject(rpcError('runtime_timeout')))
    const failed = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_1', 'first', guarded)
    const next = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_1', 'second', guarded)
    await expect(failed).rejects.toThrow('runtime_timeout')
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(next).resolves.toEqual({ status: 'sent' })
    expect(log).toEqual([
      'term_1 status',
      'term_1 paste',
      'term_1 status',
      'term_1 paste',
      'term_1 status',
      'term_1 enter'
    ])
  })

  it('sends no Enter when the handle went stale during the wait', async () => {
    queue(
      'term_1',
      'status',
      () => READY,
      () => Promise.reject(rpcError('terminal_handle_stale'))
    )
    const sending = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_1', 'note', guarded)
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(sending).resolves.toEqual({
      status: 'partial-submit-failed',
      code: 'terminal_handle_stale'
    })
    expect(log).toEqual(['term_1 status', 'term_1 paste', 'term_1 status'])
  })

  it('sends no Enter when a permission prompt appeared during the wait', async () => {
    queue(
      'term_1',
      'status',
      () => READY,
      () => ({ agentStatus: { isRunningAgent: true, status: 'permission' } })
    )
    const sending = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_1', 'note', guarded)
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(sending).resolves.toEqual({
      status: 'partial-submit-failed',
      code: 'submit-readiness-lost'
    })
    expect(log).toEqual(['term_1 status', 'term_1 paste', 'term_1 status'])
  })

  it('never repeats an Enter that got no answer', async () => {
    queue('term_1', 'enter', () => Promise.reject(rpcError('runtime_timeout')))
    const failed = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_1', 'first', guarded)
    const next = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_1', 'second', guarded)
    const rejected = expect(failed).rejects.toThrow('runtime_timeout')
    await vi.advanceTimersByTimeAsync(60_000)
    await rejected
    await expect(next).resolves.toEqual({ status: 'sent' })
    expect(log.filter((entry) => entry === 'term_1 enter')).toHaveLength(2)
  })
})

describe('a note whose Enter would wait more than 5 s', () => {
  it('is pasted and left unsent, never reported sent', async () => {
    queue('term_a', 'paste', () => accepted('term_a', 181_438))
    const sending = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_a', 'note', guarded)
    await vi.advanceTimersByTimeAsync(0)
    await expect(sending).resolves.toEqual({ status: 'pasted', pasteSettleMs: 181_438 })
    await vi.advanceTimersByTimeAsync(200_000)
    expect(log).toEqual(['term_a status', 'term_a paste'])
  })
})

describe('after a note was pasted and left for the user to send', () => {
  it('a later send is refused at once, unwritten, while the terminal took no other input', async () => {
    queue('term_c', 'status', readyAt(6), readyAt(7), readyAt(7))
    queue('term_c', 'paste', () => accepted('term_c', 4_500_000, 7))
    const left = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_c', 'long', guarded)
    const next = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_c', 'short', guarded)
    await vi.advanceTimersByTimeAsync(0)
    await expect(left).resolves.toMatchObject({ status: 'pasted' })
    await expect(next).resolves.toMatchObject({
      status: 'not-ready',
      code: 'terminal-draft-pending'
    })
    // Still so once the paste has long settled: the draft is the user's to send.
    await vi.advanceTimersByTimeAsync(5_000_000)
    const later = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_c', 'later', guarded)
    await vi.advanceTimersByTimeAsync(0)
    await expect(later).resolves.toMatchObject({
      status: 'not-ready',
      code: 'terminal-draft-pending'
    })
    expect(log).toEqual(['term_c status', 'term_c paste', 'term_c status', 'term_c status'])
  })

  it('a later send right after other input is pasted and left too while the first still settles', async () => {
    queue('term_g', 'status', readyAt(6), readyAt(8))
    queue('term_g', 'paste', () => accepted('term_g', 8_000, 7))
    const left = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_g', 'long', guarded)
    await vi.advanceTimersByTimeAsync(0)
    await expect(left).resolves.toMatchObject({ status: 'pasted' })
    const next = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_g', 'short', guarded)
    await vi.advanceTimersByTimeAsync(0)
    await expect(next).resolves.toMatchObject({ status: 'pasted' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sent('enter')).toHaveLength(0)
  })

  it("an Add to chat paste is still taken, and the note stays the user's to send", async () => {
    queue('term_e', 'status', readyAt(6), readyAt(7), readyAt(9))
    queue(
      'term_e',
      'paste',
      () => accepted('term_e', 6_000, 7),
      () => accepted('term_e', 501, 9)
    )
    const left = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_e', 'long', guarded)
    await vi.advanceTimersByTimeAsync(0)
    await expect(left).resolves.toMatchObject({ status: 'pasted' })
    const added = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_e', 'quote', {
      ...guarded,
      submit: false
    })
    await vi.advanceTimersByTimeAsync(6_000)
    await expect(added).resolves.toEqual({ status: 'sent' })
    const next = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_e', 'short', guarded)
    await vi.advanceTimersByTimeAsync(0)
    await expect(next).resolves.toMatchObject({
      status: 'not-ready',
      code: 'terminal-draft-pending'
    })
    expect(sent('enter')).toHaveLength(0)
  })
})

describe('the Enter for one paste', () => {
  it('names the paste it belongs to, so the host can refuse it over newer input', async () => {
    queue('term_1', 'paste', () => ({
      send: { handle: 'term_1', accepted: true, bytesWritten: 1, inputGeneration: 7 }
    }))
    const sending = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_1', 'note', guarded)
    await vi.advanceTimersByTimeAsync(50)
    await expect(sending).resolves.toEqual({ status: 'sent' })
    expect(sent('enter')[0]?.expectInputGeneration).toBe(7)
  })

  it('leaves the note pasted for the user when the host refuses the Enter over input they typed', async () => {
    queue('term_1', 'enter', () => ({
      send: { handle: 'term_1', accepted: false, bytesWritten: 0, refusedReason: 'input-changed' }
    }))
    const sending = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_1', 'note', guarded)
    await vi.advanceTimersByTimeAsync(50)
    await expect(sending).resolves.toEqual({ status: 'pasted', code: 'submit-send-refused' })
  })

  it('reports a failed submit when the host refuses the Enter for any other reason', async () => {
    queue('term_1', 'enter', () => ({
      send: { handle: 'term_1', accepted: false, bytesWritten: 0 }
    }))
    const sending = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_1', 'note', guarded)
    await vi.advanceTimersByTimeAsync(50)
    await expect(sending).resolves.toEqual({
      status: 'partial-submit-failed',
      code: 'submit-send-refused'
    })
  })
})

describe('sends to one terminal', () => {
  it('give up unwritten after 20 s of waiting for their turn', async () => {
    const held = deferred()
    queue('term_1', 'paste', () => held.promise)
    const first = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_1', 'first', guarded)
    const waiting = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_1', 'second', guarded)
    await vi.runAllTimersAsync()
    await expect(waiting).resolves.toEqual({ status: 'not-ready', code: 'terminal-send-busy' })
    held.resolve(accepted('term_1'))
    await vi.advanceTimersByTimeAsync(50)
    await expect(first).resolves.toEqual({ status: 'sent' })
    expect(log).toEqual(['term_1 status', 'term_1 paste', 'term_1 status', 'term_1 enter'])
  })

  it('are pasted and left unsent while an Add to chat paste needs over 5 s more to settle', async () => {
    queue('term_f', 'paste', () => accepted('term_f', 90_540))
    const added = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_f', 'quote', {
      ...guarded,
      submit: false
    })
    await vi.advanceTimersByTimeAsync(0)
    await expect(added).resolves.toEqual({ status: 'sent' })
    const early = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_f', 'early', guarded)
    await vi.advanceTimersByTimeAsync(0)
    await expect(early).resolves.toMatchObject({ status: 'pasted' })
    await vi.advanceTimersByTimeAsync(200_000)
    expect(sent('enter')).toHaveLength(0)
  })

  it('finish one send, Enter included, before the next one starts', async () => {
    queue(
      'term_1',
      'paste',
      () => accepted('term_1', 3_516),
      () => accepted('term_1', 501)
    )
    const first = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_1', 'first', guarded)
    const second = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_1', 'second', guarded)
    await vi.runAllTimersAsync()
    await expect(first).resolves.toEqual({ status: 'sent' })
    await vi.advanceTimersByTimeAsync(501)
    await expect(second).resolves.toEqual({ status: 'sent' })
    expect(log).toEqual([
      'term_1 status',
      'term_1 paste',
      'term_1 status',
      'term_1 enter',
      'term_1 status',
      'term_1 paste',
      'term_1 status',
      'term_1 enter'
    ])
  })

  it('hold the next Enter until a paste left unsent has settled', async () => {
    queue('term_1', 'paste', () => accepted('term_1', 3_516))
    const added = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_1', 'quote', {
      ...guarded,
      submit: false
    })
    const next = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_1', 'note', guarded)
    await vi.advanceTimersByTimeAsync(0)
    await expect(added).resolves.toEqual({ status: 'sent' })
    await vi.runAllTimersAsync()
    await expect(next).resolves.toEqual({ status: 'sent' })
  })

  it('issue an older host one combined send at a time', async () => {
    const held = deferred()
    queue('term_1', 'combined', () => held.promise)
    const first = sendPromptWithLegacyCombinedSend(LOCAL, 'term_1', 'first')
    const second = sendPromptWithLegacyCombinedSend(LOCAL, 'term_1', 'second')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(log).toEqual(['term_1 combined'])
    held.resolve(accepted('term_1'))
    await expect(first).resolves.toEqual({ status: 'sent' })
    await expect(second).resolves.toEqual({ status: 'sent' })
    expect(log).toEqual(['term_1 combined', 'term_1 combined'])
  })
})

describe('sends to different terminals', () => {
  it('do not wait on each other', async () => {
    queue('term_1', 'paste', () => accepted('term_1', 3_516))
    queue('term_2', 'paste', () => accepted('term_2', 501))
    const slow = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_1', 'slow', guarded)
    const quick = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_2', 'quick', guarded)
    await vi.advanceTimersByTimeAsync(501)
    await expect(quick).resolves.toEqual({ status: 'sent' })
    expect(log).not.toContain('term_1 enter')
    await vi.advanceTimersByTimeAsync(3_015)
    await expect(slow).resolves.toEqual({ status: 'sent' })
  })

  it('treat one handle on two runtimes as two terminals', async () => {
    queue(
      'term_1',
      'paste',
      () => accepted('term_1', 3_516),
      () => accepted('term_1', 501)
    )
    const slow = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_1', 'slow', guarded)
    const quick = sendPromptWithGuardedPasteAndEnter(
      { kind: 'environment', environmentId: 'env-1' },
      'term_1',
      'quick',
      guarded
    )
    await vi.advanceTimersByTimeAsync(501)
    await expect(quick).resolves.toEqual({ status: 'sent' })
    expect(log).toContain('env-1/term_1 enter')
    expect(log).not.toContain('term_1 enter')
    await vi.advanceTimersByTimeAsync(3_015)
    await expect(slow).resolves.toEqual({ status: 'sent' })
  })
})

describe('an edited draft after its automatic Enter was refused', () => {
  it('refuses another note until a deliberate terminal submit or cancellation', async () => {
    queue(
      'edited',
      'status',
      readyAt(6),
      readyAt(8),
      () => ({ ...READY, inputGeneration: 8, resolvedInputGeneration: 0 }),
      () => ({ ...READY, inputGeneration: 9, resolvedInputGeneration: 0 }),
      () => ({ ...READY, inputGeneration: 11, resolvedInputGeneration: 10 })
    )
    queue('edited', 'paste', () => accepted('edited', 100, 7))
    queue('edited', 'enter', () => ({
      send: { accepted: false, bytesWritten: 0, refusedReason: 'input-changed', inputGeneration: 8 }
    }))
    const first = sendPromptWithGuardedPasteAndEnter(LOCAL, 'edited', 'note', guarded)
    await vi.runAllTimersAsync()
    await expect(first).resolves.toMatchObject({ status: 'pasted' })
    for (const prompt of ['next', 'after another edit']) {
      const blocked = sendPromptWithGuardedPasteAndEnter(LOCAL, 'edited', prompt, guarded)
      await vi.runAllTimersAsync()
      await expect(blocked).resolves.toMatchObject({
        status: 'not-ready',
        code: 'terminal-draft-pending'
      })
    }
    expect(sent('paste').map((p) => p.text)).toEqual(['\x1b[200~note\x1b[201~'])
    const resumed = sendPromptWithGuardedPasteAndEnter(LOCAL, 'edited', 'after Enter', guarded)
    await vi.runAllTimersAsync()
    await expect(resumed).resolves.toEqual({ status: 'sent' })
  })

  it('carries the unsettled paste into an immediate refusal', async () => {
    queue('settling', 'status', readyAt(6), readyAt(7))
    queue('settling', 'paste', () => accepted('settling', 181_438, 7))
    await expect(
      sendPromptWithGuardedPasteAndEnter(LOCAL, 'settling', 'long', guarded)
    ).resolves.toMatchObject({ status: 'pasted' })
    await expect(
      sendPromptWithGuardedPasteAndEnter(LOCAL, 'settling', 'next', guarded)
    ).resolves.toEqual({
      status: 'not-ready',
      code: 'terminal-draft-pending',
      pasteSettleMs: 181_438
    })
    expect(sent('paste').map((p) => p.text)).toEqual(['\x1b[200~long\x1b[201~'])
  })

  it('forgets a retired terminal while preserving a live draft', async () => {
    const ended = admitTerminalNoticeLifetime('pty-ended')
    const live = admitTerminalNoticeLifetime('pty-live')
    queue('ended', 'status', readyAt(6), readyAt(7))
    queue('live', 'status', readyAt(6), readyAt(7))
    queue('ended', 'paste', () => accepted('ended', 181_438, 7))
    queue('live', 'paste', () => accepted('live', 181_438, 7))
    await sendPromptWithGuardedPasteAndEnter(LOCAL, 'ended', 'old', {
      ...guarded,
      ptyId: 'pty-ended'
    })
    await sendPromptWithGuardedPasteAndEnter(LOCAL, 'live', 'live draft', {
      ...guarded,
      ptyId: 'pty-live'
    })
    retireTerminalNoticeLifetime(ended)
    await expect(
      sendPromptWithGuardedPasteAndEnter(LOCAL, 'live', 'next', { ...guarded, ptyId: 'pty-live' })
    ).resolves.toMatchObject({ status: 'not-ready', code: 'terminal-draft-pending' })
    const next = sendPromptWithGuardedPasteAndEnter(LOCAL, 'ended', 'new process', {
      ...guarded,
      ptyId: 'pty-ended'
    })
    await vi.runAllTimersAsync()
    await expect(next).resolves.toEqual({ status: 'sent' })
    retireTerminalNoticeLifetime(live)
  })
})
