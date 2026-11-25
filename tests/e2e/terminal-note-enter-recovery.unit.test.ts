import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeTerminalWriter } from '../../src/main/runtime/terminal/input/runtime-terminal-writer'
import { writeTerminalSendForReceipt } from '../../src/main/runtime/terminal/input/terminal-send-receipt'
import { TerminalRunFactsRegister } from '../../src/main/runtime/terminal/lifecycle/terminal-run-facts'
import {
  WRITE_ACCEPTED,
  writeRefused,
  writeUnverifiable
} from '../../src/shared/terminal/pty/lifecycle/pty-write-settlement'
import { sendPromptWithGuardedPasteAndEnter } from '@/lib/agent-session/messaging/terminal/active-agent-note-send-delivery'
import {
  admitTerminalNoticeLifetime,
  retireTerminalNoticeLifetime
} from '@/components/terminal-pane/provider-notices/terminal-notice-lifetime'

const { callRuntimeRpc } = vi.hoisted(() => ({ callRuntimeRpc: vi.fn() }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc }))
vi.mock('@/lib/agent-session/messaging/paste/agent-paste-draft', () => ({}))

type EnterCase =
  | 'permission'
  | 'readiness-lost'
  | 'guard-refusal'
  | 'provider-refusal'
  | 'lost-before-write'
  | 'lost-after-write'
  | 'delayed-lost'
  | 'unknown-without-resolution'
  | 'unknown-after-write'
  | 'success'
  | 'retired-during-enter'

type SendParams = { text?: string; enter?: boolean; expectInputGeneration?: number }

function terminal(enterCase: EnterCase, reportsResolution = true, receiptGeneration = true) {
  const ptyId = 'enter-recovery-pty'
  const handle = 'enter-recovery-terminal'
  const facts = new TerminalRunFactsRegister()
  let lifetime = admitTerminalNoticeLifetime(ptyId)
  let faultArmed = true
  let pasted = false
  let output = ''
  let releaseEnter = () => {}
  const enterGate = new Promise<void>((resolve) => {
    releaseEnter = resolve
  })
  let pendingEnter: Promise<unknown> | undefined
  const replace = () => {
    retireTerminalNoticeLifetime(lifetime)
    facts.delete(ptyId)
    lifetime = admitTerminalNoticeLifetime(ptyId, { fresh: true })
    output = ''
  }
  const accept = (data: string) => {
    facts.recordInput(ptyId, 'driving', data)
    output += data
    return true
  }
  const writer = new RuntimeTerminalWriter(
    (_id, data) => accept(data),
    () => 'linux',
    () => 'claude',
    (_id, data) => {
      if (faultArmed && enterCase === 'provider-refusal') {
        return writeRefused('transport_rejected_before_handoff')
      }
      if (faultArmed && enterCase === 'unknown-without-resolution') {
        return writeUnverifiable('transport_settlement_lost', true)
      }
      accept(data)
      return faultArmed && enterCase === 'unknown-after-write'
        ? writeUnverifiable('transport_settlement_lost', true)
        : WRITE_ACCEPTED
    }
  )
  callRuntimeRpc.mockImplementation(async (_target, method: string, params: SendParams) => {
    if (method === 'terminal.agentStatus') {
      if (faultArmed && pasted && enterCase === 'readiness-lost') {
        throw Object.assign(new Error('runtime_timeout'), { code: 'runtime_timeout' })
      }
      return {
        agentStatus: {
          isRunningAgent: true,
          status: faultArmed && pasted && enterCase === 'permission' ? 'permission' : 'idle'
        },
        ...(reportsResolution
          ? {
              inputGeneration: facts.readInputGeneration(ptyId),
              resolvedInputGeneration: facts.readResolvedInputGeneration(ptyId)
            }
          : {})
      }
    }
    if (params.enter && faultArmed && enterCase === 'lost-before-write') {
      throw Object.assign(new Error('runtime_timeout'), { code: 'runtime_timeout' })
    }
    if (params.enter && faultArmed && enterCase === 'retired-during-enter') {
      replace()
      return { send: { handle, accepted: false, bytesWritten: 0 } }
    }
    try {
      const delivery = writeTerminalSendForReceipt(
        {
          writer,
          runFacts: facts,
          writeAction: (options) =>
            writer.writeAction(ptyId, params, params.text ?? '\r', {
              ...options,
              ...(params.enter ? { requireWriteSettlement: true as const } : {}),
              beforeWrite: async () => {
                if (params.enter && faultArmed && enterCase === 'delayed-lost') {
                  await enterGate
                }
                if (params.enter && faultArmed && enterCase === 'guard-refusal') {
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
            ...(params.text ? { clientSubmit: true as const } : {})
          }
        }
      )
      if (params.enter && faultArmed && enterCase === 'delayed-lost') {
        pendingEnter = delivery
        throw Object.assign(new Error('runtime_timeout'), { code: 'runtime_timeout' })
      }
      const send = await delivery
      pasted ||= !!params.text
      if (params.enter && faultArmed && enterCase === 'lost-after-write') {
        throw Object.assign(new Error('runtime_timeout'), { code: 'runtime_timeout' })
      }
      return {
        send:
          reportsResolution && receiptGeneration ? send : { ...send, inputGeneration: undefined }
      }
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
    restorePermission: () => {
      faultArmed = false
    },
    manual: (data: string) => accept(data),
    replace,
    finishEnter: async () => {
      releaseEnter()
      await pendingEnter
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

it.each<EnterCase>([
  'permission',
  'guard-refusal',
  'provider-refusal',
  'lost-before-write',
  'unknown-without-resolution'
])(
  'retains the accepted draft after %s and blocks automatic and clicked notes until manual resolution',
  async (enterCase) => {
    vi.useFakeTimers()
    active = terminal(enterCase)
    const first = active.send('accepted note', true)
    await vi.runAllTimersAsync()
    if (enterCase === 'lost-before-write') {
      expect(await first).toBeInstanceOf(Error)
    } else {
      expect(await first).toEqual({
        status: 'partial-submit-failed',
        code:
          enterCase === 'permission'
            ? 'submit-readiness-lost'
            : enterCase === 'unknown-without-resolution'
              ? 'submit-send-error'
              : 'submit-send-refused'
      })
    }
    active.restorePermission()
    for (const clicked of [false, true]) {
      const next = active.send('must stay separate', clicked)
      await vi.runAllTimersAsync()
      expect(await next).toMatchObject({ status: 'not-ready', code: 'terminal-draft-pending' })
    }
    expect(active.output()).toBe('\x1b[200~accepted note\x1b[201~')
    active.manual('\x03')
    for (const clicked of [false, true]) {
      const next = active.send('after cancellation', clicked)
      await vi.runAllTimersAsync()
      expect(await next).toEqual({ status: 'sent' })
    }
    expect(active.output()).toBe(
      '\x1b[200~accepted note\x1b[201~\x03\x1b[200~after cancellation\x1b[201~\r\x1b[200~after cancellation\x1b[201~\r'
    )
  }
)

it.each<EnterCase>(['lost-after-write', 'unknown-after-write', 'success'])(
  'does not leave a permanent fence after %s submitted the accepted draft',
  async (enterCase) => {
    vi.useFakeTimers()
    active = terminal(enterCase)
    const first = active.send('accepted note', true)
    await vi.runAllTimersAsync()
    if (enterCase === 'lost-after-write') {
      expect(await first).toBeInstanceOf(Error)
    } else if (enterCase === 'unknown-after-write') {
      expect(await first).toEqual({ status: 'partial-submit-failed', code: 'submit-send-error' })
    } else {
      expect(await first).toEqual({ status: 'sent' })
    }
    active.restorePermission()
    for (const clicked of [false, true]) {
      const next = active.send('next note', clicked)
      await vi.runAllTimersAsync()
      expect(await next).toEqual({ status: 'sent' })
    }
    expect(active.output()).toBe(
      '\x1b[200~accepted note\x1b[201~\r\x1b[200~next note\x1b[201~\r\x1b[200~next note\x1b[201~\r'
    )
  }
)

it.each<EnterCase>(['permission', 'retired-during-enter'])(
  'forgets the accepted checkpoint on retirement and replacement after %s',
  async (enterCase) => {
    vi.useFakeTimers()
    active = terminal(enterCase)
    const first = active.send('old process note', true)
    await vi.runAllTimersAsync()
    expect(await first).toMatchObject({ status: 'partial-submit-failed' })
    if (enterCase === 'permission') {
      active.replace()
    }
    active.restorePermission()
    for (const clicked of [false, true]) {
      const next = active.send('new process note', clicked)
      await vi.runAllTimersAsync()
      expect(await next).toEqual({ status: 'sent' })
    }
    expect(active.output()).toBe(
      '\x1b[200~new process note\x1b[201~\r\x1b[200~new process note\x1b[201~\r'
    )
  }
)

it('keeps a lost Enter reply fenced while the host is still waiting, then reconciles its eventual submission', async () => {
  vi.useFakeTimers()
  active = terminal('delayed-lost')
  const first = active.send('accepted note', true)
  await vi.runAllTimersAsync()
  expect(await first).toBeInstanceOf(Error)
  for (const clicked of [false, true]) {
    const next = active.send('must stay separate', clicked)
    await vi.runAllTimersAsync()
    expect(await next).toMatchObject({ status: 'not-ready', code: 'terminal-draft-pending' })
  }
  expect(active.output()).toBe('\x1b[200~accepted note\x1b[201~')
  await active.finishEnter()
  active.restorePermission()
  for (const clicked of [false, true]) {
    const next = active.send('after settled Enter', clicked)
    await vi.runAllTimersAsync()
    expect(await next).toEqual({ status: 'sent' })
  }
  expect(active.output()).toBe(
    '\x1b[200~accepted note\x1b[201~\r\x1b[200~after settled Enter\x1b[201~\r\x1b[200~after settled Enter\x1b[201~\r'
  )
})

it('preserves explicit-click recovery after a lost successful Enter reply on a host without resolution reporting', async () => {
  vi.useFakeTimers()
  active = terminal('lost-after-write', false)
  const first = active.send('accepted note', true)
  await vi.runAllTimersAsync()
  expect(await first).toBeInstanceOf(Error)
  active.restorePermission()
  const automatic = active.send('automatic', false)
  await vi.runAllTimersAsync()
  expect(await automatic).toMatchObject({ status: 'not-ready', code: 'terminal-draft-pending' })
  const clicked = active.send('explicit retry', true)
  await vi.runAllTimersAsync()
  expect(await clicked).toEqual({ status: 'sent' })
  expect(active.output()).toBe(
    '\x1b[200~accepted note\x1b[201~\r\x1b[200~explicit retry\x1b[201~\r'
  )
})

it('reconciles a successful Enter with a lost reply when the accepted paste receipt omitted its generation', async () => {
  vi.useFakeTimers()
  active = terminal('lost-after-write', true, false)
  const first = active.send('accepted note', true)
  await vi.runAllTimersAsync()
  expect(await first).toBeInstanceOf(Error)
  active.restorePermission()
  for (const clicked of [false, true]) {
    const next = active.send('next note', clicked)
    await vi.runAllTimersAsync()
    expect(await next).toEqual({ status: 'sent' })
  }
  expect(active.output()).toBe(
    '\x1b[200~accepted note\x1b[201~\r\x1b[200~next note\x1b[201~\r\x1b[200~next note\x1b[201~\r'
  )
})

it.each<EnterCase>(['permission', 'readiness-lost'])(
  'allows manual resolution after %s prevented Enter when the accepted paste receipt omitted its generation',
  async (enterCase) => {
    vi.useFakeTimers()
    active = terminal(enterCase, true, false)
    const first = active.send('accepted note', true)
    await vi.runAllTimersAsync()
    if (enterCase === 'readiness-lost') {
      expect(await first).toBeInstanceOf(Error)
    } else {
      expect(await first).toMatchObject({ status: 'partial-submit-failed' })
    }
    active.restorePermission()
    for (const clicked of [false, true]) {
      const next = active.send('must stay separate', clicked)
      await vi.runAllTimersAsync()
      expect(await next).toMatchObject({ status: 'not-ready', code: 'terminal-draft-pending' })
    }
    expect(active.output()).toBe('\x1b[200~accepted note\x1b[201~')
    active.manual('\r')
    for (const clicked of [false, true]) {
      const next = active.send('after manual Enter', clicked)
      await vi.runAllTimersAsync()
      expect(await next).toEqual({ status: 'sent' })
    }
    expect(active.output()).toBe(
      '\x1b[200~accepted note\x1b[201~\r\x1b[200~after manual Enter\x1b[201~\r\x1b[200~after manual Enter\x1b[201~\r'
    )
  }
)
