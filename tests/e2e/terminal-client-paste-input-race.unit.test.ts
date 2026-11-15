import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeTerminalWriter } from '../../src/main/runtime/terminal/input/runtime-terminal-writer'
import { writeTerminalSendForReceipt } from '../../src/main/runtime/terminal/input/terminal-send-receipt'
import { TerminalRunFactsRegister } from '../../src/main/runtime/terminal/lifecycle/terminal-run-facts'
import { sendPromptWithGuardedPasteAndEnter } from '@/lib/agent-session/messaging/terminal/active-agent-note-send-delivery'
import { forgetTerminalNoteDraft } from '@/lib/agent-session/messaging/terminal/active-agent-terminal-send-lane'

const { callRuntimeRpc } = vi.hoisted(() => ({ callRuntimeRpc: vi.fn() }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc }))
vi.mock('@/lib/agent-session/messaging/paste/agent-paste-draft', () => ({}))

afterEach(() => {
  forgetTerminalNoteDraft('race-pty')
  vi.useRealTimers()
  callRuntimeRpc.mockReset()
})

it.each(['\r', '\x03'])(
  'keeps a draft fenced after %j arrives between real paste writes',
  async (earlyInput) => {
    vi.useFakeTimers()
    const facts = new TerminalRunFactsRegister()
    const writes: string[] = []
    let injected = false
    const writer = new RuntimeTerminalWriter(
      (_ptyId, data) => {
        facts.recordInput('race-pty', 'driving', data)
        writes.push(data)
        if (!injected) {
          injected = true
          queueMicrotask(() => {
            facts.recordInput('race-pty', 'driving', earlyInput)
            writes.push(earlyInput)
          })
        }
        return true
      },
      () => 'win32',
      () => 'antigravity'
    )
    callRuntimeRpc.mockImplementation(async (_target, method, params) => {
      if (method === 'terminal.agentStatus') {
        return {
          agentStatus: { isRunningAgent: true, status: 'idle' },
          inputGeneration: facts.readInputGeneration('race-pty'),
          resolvedInputGeneration: facts.readResolvedInputGeneration('race-pty')
        }
      }
      return {
        send: await writeTerminalSendForReceipt(
          {
            writer,
            runFacts: facts,
            writeAction: (options) =>
              writer.writeAction('race-pty', params, params.text ?? '\r', options)
          },
          {
            handle: 'race-terminal',
            ptyId: 'race-pty',
            action: params,
            payload: params.text ?? '\r',
            options: {
              ...(params.text ? { clientSubmit: true as const } : {}),
              inputKind: 'driving'
            }
          }
        )
      }
    })
    const target = { kind: 'local' } as const
    const options = { allowLegacyFallback: false, ptyId: 'race-pty', userInitiated: true }
    const prompt = 'synthetic note\n'.repeat(10_000)
    const first = sendPromptWithGuardedPasteAndEnter(target, 'race-terminal', prompt, options)
    await vi.runAllTimersAsync()
    await expect(first).resolves.toMatchObject({ status: 'pasted' })
    await vi.advanceTimersByTimeAsync(86_400_000)
    const blocked = sendPromptWithGuardedPasteAndEnter(
      target,
      'race-terminal',
      'later note',
      options
    )
    await vi.runAllTimersAsync()
    await expect(blocked).resolves.toMatchObject({
      status: 'not-ready',
      code: 'terminal-draft-pending'
    })
    expect(writes.filter((data) => data !== earlyInput).join('')).toBe(
      `\x1b[200~${prompt}\x1b[201~`
    )
    facts.recordInput('race-pty', 'driving', '\r')
    const next = sendPromptWithGuardedPasteAndEnter(
      target,
      'race-terminal',
      'after manual submit',
      options
    )
    await vi.runAllTimersAsync()
    await expect(next).resolves.toEqual({ status: 'sent' })
  }
)
