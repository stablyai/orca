import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeTerminalWriter } from '../../src/main/runtime/terminal/input/runtime-terminal-writer'
import { writeTerminalSendForReceipt } from '../../src/main/runtime/terminal/input/terminal-send-receipt'
import { TerminalRunFactsRegister } from '../../src/main/runtime/terminal/lifecycle/terminal-run-facts'
import {
  WRITE_ACCEPTED,
  writeRefused
} from '../../src/shared/terminal/pty/lifecycle/pty-write-settlement'
import type { RuntimeTerminalClientPaste } from '../../src/shared/terminal/runtime/runtime-terminal-send-contract'
import { sendPromptWithGuardedPasteAndEnter } from '@/lib/agent-session/messaging/terminal/active-agent-note-send-delivery'
import {
  admitTerminalNoticeLifetime,
  retireTerminalNoticeLifetime
} from '@/components/terminal-pane/provider-notices/terminal-notice-lifetime'

const { callRuntimeRpc } = vi.hoisted(() => ({ callRuntimeRpc: vi.fn() }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc }))
vi.mock('@/lib/agent-session/messaging/paste/agent-paste-draft', () => ({}))

/** What goes wrong with the first note's paste request. */
type PasteCase =
  | 'lost-after-write'
  | 'partial-write'
  | 'arrives-late'
  | 'still-writing'
  | 'guard-refusal'

type SendParams = {
  text?: string
  enter?: boolean
  expectInputGeneration?: number
  clientPaste?: RuntimeTerminalClientPaste
}

const timeout = () => Object.assign(new Error('runtime_timeout'), { code: 'runtime_timeout' })
const LONG_NOTE = 'long note '.repeat(4_000)

/** A terminal whose host is the real writer, receipt and run facts; only the RPC hop is modeled.
 *  `currentHost: false` models a released host: it strips `clientPaste` and reports no generations. */
function terminal(pasteCase: PasteCase, currentHost = true) {
  const ptyId = 'lost-paste-pty'
  const handle = 'lost-paste-terminal'
  const facts = new TerminalRunFactsRegister()
  let lifetime = admitTerminalNoticeLifetime(ptyId)
  let faultArmed = true
  let output = ''
  let releaseWrite = () => {}
  const writeGate = new Promise<void>((resolve) => {
    releaseWrite = resolve
  })
  let held: (() => Promise<unknown>) | undefined
  let heldDelivery: Promise<unknown> | undefined
  const accept = (data: string) => {
    facts.recordInput(ptyId, 'driving', data)
    output += data
    return true
  }
  let settledWrites = 0
  const writer = new RuntimeTerminalWriter(
    (_id, data) => accept(data),
    () => 'linux',
    () => 'claude',
    (_id, data) => {
      settledWrites += 1
      // The transport takes the first chunk, then fails: only a prefix reached the terminal.
      if (faultArmed && pasteCase === 'partial-write' && settledWrites > 1) {
        return writeRefused('transport_rejected_before_handoff')
      }
      accept(data)
      return WRITE_ACCEPTED
    }
  )
  const deliver = (params: SendParams) =>
    writeTerminalSendForReceipt(
      {
        writer,
        runFacts: facts,
        writeAction: (options) =>
          writer.writeAction(ptyId, params, params.text ?? '\r', {
            ...options,
            ...(params.enter || (faultArmed && pasteCase === 'partial-write')
              ? { requireWriteSettlement: true as const }
              : {}),
            beforeWrite: async () => {
              if (params.text && faultArmed && pasteCase === 'still-writing') {
                await writeGate
              }
              if (params.text && faultArmed && pasteCase === 'guard-refusal') {
                throw new Error('terminal_guard_permission')
              }
            },
            reserveWrite: () => {
              if (
                params.expectInputGeneration !== undefined &&
                params.expectInputGeneration !== facts.readInputGeneration(ptyId)
              ) {
                throw new Error('terminal_guard_input_changed')
              }
            }
          })
      },
      {
        handle,
        ptyId,
        action: params,
        payload: params.text ?? '\r',
        options: {
          inputKind: 'driving',
          ...(params.text ? { clientSubmit: true as const } : {}),
          ...(currentHost && params.clientPaste ? { clientPaste: params.clientPaste } : {})
        }
      }
    )
  callRuntimeRpc.mockImplementation(async (_target, method: string, params: SendParams) => {
    if (method === 'terminal.agentStatus') {
      return {
        agentStatus: { isRunningAgent: true, status: 'idle' },
        ...(currentHost
          ? {
              ...(params.clientPaste
                ? { clientPaste: facts.reconcileClientPaste(ptyId, params.clientPaste) }
                : {}),
              inputGeneration: facts.readInputGeneration(ptyId),
              resolvedInputGeneration: facts.readResolvedInputGeneration(ptyId)
            }
          : {})
      }
    }
    const paste = !!params.text && faultArmed
    if (paste && pasteCase === 'arrives-late' && !held) {
      // The request is still in transit when the client gives up on it.
      held = () => deliver(params)
      throw timeout()
    }
    try {
      const delivery = deliver(params)
      if (paste && pasteCase === 'still-writing') {
        heldDelivery = delivery
        throw timeout()
      }
      const send = await delivery
      if (paste && pasteCase === 'lost-after-write') {
        throw timeout()
      }
      return { send: currentHost ? send : { ...send, inputGeneration: undefined } }
    } catch (error) {
      if (error instanceof Error && error.message === 'terminal_guard_permission') {
        return { send: { handle, accepted: false, bytesWritten: 0, refusedReason: 'permission' } }
      }
      throw error
    }
  })
  const send = (prompt: string, userInitiated: boolean) => {
    const result = sendPromptWithGuardedPasteAndEnter({ kind: 'local' }, handle, prompt, {
      allowLegacyFallback: false,
      ptyId,
      userInitiated
    })
    // Observe a rejected RPC before advancing fake timers.
    return result.then(
      (value) => value,
      (error: unknown) => error
    )
  }
  return {
    send,
    output: () => output,
    clearFault: () => {
      faultArmed = false
    },
    manual: (data: string) => accept(data),
    replace: () => {
      retireTerminalNoticeLifetime(lifetime)
      facts.delete(ptyId)
      lifetime = admitTerminalNoticeLifetime(ptyId, { fresh: true })
      output = ''
    },
    arriveLate: () => held!(),
    finishWrite: async () => {
      releaseWrite()
      await heldDelivery
    },
    dispose: () => retireTerminalNoticeLifetime(lifetime)
  }
}

let active: ReturnType<typeof terminal> | undefined

afterEach(() => {
  active?.dispose()
  active = undefined
  vi.useRealTimers()
  callRuntimeRpc.mockReset()
})

const pasted = (text: string) => `\x1b[200~${text}\x1b[201~`

async function expectBlocked(target: ReturnType<typeof terminal>): Promise<void> {
  for (const clicked of [false, true]) {
    const next = target.send('second note', clicked)
    await vi.runAllTimersAsync()
    expect(await next).toMatchObject({ status: 'not-ready', code: 'terminal-draft-pending' })
  }
}

async function expectBothSent(target: ReturnType<typeof terminal>, prompt: string): Promise<void> {
  for (const clicked of [false, true]) {
    const next = target.send(prompt, clicked)
    await vi.runAllTimersAsync()
    expect(await next).toEqual({ status: 'sent' })
  }
}

it('keeps a fully written paste whose reply was lost from being submitted with the next note', async () => {
  vi.useFakeTimers()
  active = terminal('lost-after-write')
  const first = active.send('first note', true)
  await vi.runAllTimersAsync()
  expect(await first).toBeInstanceOf(Error)
  active.clearFault()
  await expectBlocked(active)
  expect(active.output()).toBe(pasted('first note'))
  await vi.advanceTimersByTimeAsync(60_000)
  active.manual('\x03')
  await expectBothSent(active, 'after cancellation')
  expect(active.output()).toBe(
    `${pasted('first note')}\x03${pasted('after cancellation')}\r${pasted('after cancellation')}\r`
  )
})

it('keeps a partly written paste fenced until the user resolves the prefix left in the input', async () => {
  vi.useFakeTimers()
  active = terminal('partial-write')
  const first = active.send(LONG_NOTE, true)
  await vi.runAllTimersAsync()
  expect(await first).toEqual({ status: 'not-writable', code: 'terminal-send-refused' })
  const prefix = active.output()
  expect(prefix.length).toBeGreaterThan(0)
  expect(pasted(LONG_NOTE).startsWith(prefix)).toBe(true)
  expect(prefix).not.toBe(pasted(LONG_NOTE))
  active.clearFault()
  await expectBlocked(active)
  expect(active.output()).toBe(prefix)
  await vi.advanceTimersByTimeAsync(60_000)
  active.manual('\r')
  await expectBothSent(active, 'after manual Enter')
  expect(active.output()).toBe(
    `${prefix}\r${pasted('after manual Enter')}\r${pasted('after manual Enter')}\r`
  )
})

it('withdraws a paste that had not reached the host, so it cannot land after the next note', async () => {
  vi.useFakeTimers()
  active = terminal('arrives-late')
  const first = active.send('first note', true)
  await vi.runAllTimersAsync()
  expect(await first).toBeInstanceOf(Error)
  const next = active.send('second note', false)
  await vi.runAllTimersAsync()
  expect(await next).toEqual({ status: 'sent' })
  // The first request finally arrives: it is refused before writing anything.
  expect(await active.arriveLate()).toMatchObject({ accepted: false, bytesWritten: 0 })
  active.clearFault()
  await expectBothSent(active, 'third note')
  expect(active.output()).toBe(
    `${pasted('second note')}\r${pasted('third note')}\r${pasted('third note')}\r`
  )
})

it('waits for a paste the host is still writing, and an Enter during the write does not resolve it', async () => {
  vi.useFakeTimers()
  active = terminal('still-writing')
  const first = active.send('first note', true)
  await vi.runAllTimersAsync()
  expect(await first).toBeInstanceOf(Error)
  for (const clicked of [false, true]) {
    const next = active.send('second note', clicked)
    await vi.runAllTimersAsync()
    const result = await next
    expect(result).toMatchObject({ status: 'not-ready', code: 'terminal-draft-pending' })
    const settleMs =
      typeof result === 'object' && result !== null && 'pasteSettleMs' in result
        ? result.pasteSettleMs
        : undefined
    expect(settleMs).toBeGreaterThan(0)
  }
  expect(active.output()).toBe('')
  active.manual('\x03')
  await active.finishWrite()
  active.clearFault()
  await expectBlocked(active)
  expect(active.output()).toBe(`\x03${pasted('first note')}`)
  await vi.advanceTimersByTimeAsync(60_000)
  active.manual('\r')
  await expectBothSent(active, 'after manual Enter')
  expect(active.output()).toBe(
    `\x03${pasted('first note')}\r${pasted('after manual Enter')}\r${pasted('after manual Enter')}\r`
  )
})

it('leaves no fence after a paste the host refused before writing', async () => {
  vi.useFakeTimers()
  active = terminal('guard-refusal')
  const first = active.send('first note', true)
  await vi.runAllTimersAsync()
  expect(await first).toEqual({ status: 'permission', code: 'terminal-send-permission' })
  active.clearFault()
  await expectBothSent(active, 'next note')
  expect(active.output()).toBe(`${pasted('next note')}\r${pasted('next note')}\r`)
})

it('forgets a lost paste when its terminal is replaced', async () => {
  vi.useFakeTimers()
  active = terminal('lost-after-write')
  const first = active.send('old process note', true)
  await vi.runAllTimersAsync()
  expect(await first).toBeInstanceOf(Error)
  active.replace()
  active.clearFault()
  await expectBothSent(active, 'new process note')
  expect(active.output()).toBe(`${pasted('new process note')}\r${pasted('new process note')}\r`)
})

it('on a released host, refuses automatic notes after a lost paste reply and keeps explicit-click recovery', async () => {
  vi.useFakeTimers()
  active = terminal('lost-after-write', false)
  const first = active.send('first note', true)
  await vi.runAllTimersAsync()
  expect(await first).toBeInstanceOf(Error)
  active.clearFault()
  const automatic = active.send('automatic note', false)
  await vi.runAllTimersAsync()
  expect(await automatic).toMatchObject({ status: 'not-ready', code: 'terminal-draft-pending' })
  expect(active.output()).toBe(pasted('first note'))
  await vi.advanceTimersByTimeAsync(60_000)
  const clicked = active.send('explicit retry', true)
  await vi.runAllTimersAsync()
  expect(await clicked).toEqual({ status: 'sent' })
  // Nothing is written twice; the user chose to send behind the waiting note.
  expect(active.output()).toBe(`${pasted('first note')}${pasted('explicit retry')}\r`)
})
