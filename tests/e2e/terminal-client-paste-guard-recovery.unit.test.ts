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
  forgetTerminalNoteDraft('guard-pty')
  vi.useRealTimers()
  callRuntimeRpc.mockReset()
})

async function recoverAfterGuardRefusal(
  guard: 'beforeWrite' | 'reserveWrite',
  manualInput: string
) {
  vi.useFakeTimers()
  const facts = new TerminalRunFactsRegister()
  const writes: string[] = []
  let refuse = false
  const writer = new RuntimeTerminalWriter(
    (_id, data) => {
      facts.recordInput('guard-pty', 'driving', data)
      writes.push(data)
      return true
    },
    () => 'win32',
    () => 'antigravity'
  )
  callRuntimeRpc.mockImplementation(async (_target, method, params) => {
    if (method === 'terminal.agentStatus') {
      return {
        agentStatus: { isRunningAgent: true, status: 'idle' },
        inputGeneration: facts.readInputGeneration('guard-pty'),
        resolvedInputGeneration: facts.readResolvedInputGeneration('guard-pty')
      }
    }
    try {
      return {
        send: await writeTerminalSendForReceipt(
          {
            writer,
            runFacts: facts,
            writeAction: (options) =>
              writer.writeAction('guard-pty', params, params.text ?? '\r', {
                ...options,
                [guard]: () => {
                  if (refuse) {
                    throw new Error('terminal_guard_permission')
                  }
                }
              })
          },
          {
            handle: 'guard-term',
            ptyId: 'guard-pty',
            action: params,
            payload: params.text ?? '\r',
            options: {
              ...(params.text ? { clientSubmit: true as const } : {}),
              inputKind: 'driving'
            }
          }
        )
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'terminal_guard_permission') {
        return {
          send: {
            handle: 'guard-term',
            accepted: false,
            bytesWritten: 0,
            refusedReason: 'permission'
          }
        }
      }
      throw error
    }
  })
  const target = { kind: 'local' } as const
  const options = { allowLegacyFallback: false, ptyId: 'guard-pty', userInitiated: true }
  const prompt = 'note\n'.repeat(30_000)
  const first = sendPromptWithGuardedPasteAndEnter(target, 'guard-term', prompt, options)
  await vi.runAllTimersAsync()
  await expect(first).resolves.toMatchObject({ status: 'pasted' })
  await vi.advanceTimersByTimeAsync(86_400_000)
  writes.length = 0
  refuse = true
  const rejected = sendPromptWithGuardedPasteAndEnter(target, 'guard-term', prompt, {
    ...options,
    submit: false
  })
  await vi.runAllTimersAsync()
  await expect(rejected).resolves.toMatchObject({ status: 'permission' })
  expect(writes.join('')).toBe('')
  refuse = false
  facts.recordInput('guard-pty', 'driving', manualInput)
  const next = sendPromptWithGuardedPasteAndEnter(target, 'guard-term', 'next', options)
  await vi.runAllTimersAsync()
  await expect(next).resolves.toEqual({ status: 'sent' })
  expect(writes.join('')).toBe('\x1b[200~next\x1b[201~\r')
}

it('allows manual submission to recover a settled draft after the first permission guard refused a paste', async () => {
  await recoverAfterGuardRefusal('beforeWrite', '\r')
})

it('allows manual cancellation to recover a settled draft after the first write reservation refused a paste', async () => {
  await recoverAfterGuardRefusal('reserveWrite', '\x03')
})
