import { beforeEach, describe, expect, it, vi } from 'vitest'
const { call, CapabilityError } = vi.hoisted(() => ({
  call: vi.fn(),
  CapabilityError: class extends Error {}
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: call,
  StructuredAgentSessionCapabilityError: CapabilityError
}))
// Interpolates like the real `translate`: a refusal that carries the provider's words renders
// them, so a mock that returned the raw fallback would hide exactly the regression under test.
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, params?: Record<string, string>) =>
    Object.entries(params ?? {}).reduce(
      (text, [name, value]) => text.replaceAll(`{{${name}}}`, value),
      fallback
    )
}))
import { forkStructuredSessionFromTurn } from './structured-agent-session-fork-command'

let id = 0
const input = () => ({
  target: { kind: 'local' } as const,
  worktree: 'workspace',
  agent: 'codex' as const,
  source: {
    sessionId: `parent-${++id}`,
    itemId: 'codex:parent:turn:1',
    expectedEpoch: 'epoch',
    expectedRuntimeFence: 1
  }
})
beforeEach(() => {
  call.mockReset()
})

describe('fork create intent replay', () => {
  it('replays the exact child id and operation after a lost reply', async () => {
    const args = input()
    call
      .mockRejectedValueOnce(new Error('disconnected'))
      .mockResolvedValueOnce({ ok: true, value: { sessionId: 'child' } })
    await expect(forkStructuredSessionFromTurn(args)).rejects.toThrow('could not be confirmed')
    await forkStructuredSessionFromTurn(args)
    expect(call.mock.calls[1]?.[2]).toEqual(call.mock.calls[0]?.[2])
    expect(call.mock.calls[0]?.[2]).toMatchObject({
      forkFrom: args.source,
      envelope: { expectedRuntimeFence: null }
    })
  })

  it('routes the create to the parent execution host and never falls back locally', async () => {
    const args = {
      ...input(),
      target: { kind: 'environment', environmentId: 'remote-host' } as const
    }
    call.mockRejectedValue(new Error('unreachable'))
    await expect(forkStructuredSessionFromTurn(args)).rejects.toThrow('could not be confirmed')
    expect(call).toHaveBeenCalledTimes(1)
    expect(call.mock.calls[0]?.[0]).toEqual(args.target)
  })

  it('joins simultaneous clicks into one create request', async () => {
    let finish!: (value: unknown) => void
    call.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const args = input()
    const first = forkStructuredSessionFromTurn(args)
    const second = forkStructuredSessionFromTurn(args)
    expect(second).toBe(first)
    finish({ ok: true, value: { sessionId: 'child' } })
    await first
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('allows a fresh attempt after a pre-commit busy refusal', async () => {
    const args = input()
    call
      .mockResolvedValueOnce({ ok: false, refusal: { forkReason: 'busy' } })
      .mockResolvedValueOnce({ ok: true, value: { sessionId: 'child' } })
    await expect(forkStructuredSessionFromTurn(args)).rejects.toThrow('Wait for this conversation')
    await forkStructuredSessionFromTurn(args)
    expect(call.mock.calls[1]?.[2].envelope.sessionId).not.toBe(
      call.mock.calls[0]?.[2].envelope.sessionId
    )
  })

  it.each([
    ['unsupported', 'cannot be forked'],
    ['history-limit', 'too much history'],
    ['stale-epoch', 'moved on'],
    ['invalid-target', 'Could not fork this turn.'],
    ['outcome-unknown', 'could not be confirmed']
  ])('reports a %s refusal in its own words', async (forkReason, message) => {
    call.mockResolvedValue({ ok: false, refusal: { forkReason } })
    await expect(forkStructuredSessionFromTurn(input())).rejects.toThrow(message)
  })

  it("reports a settled provider rejection in the provider's own words and retires the attempt", async () => {
    const args = input()
    call
      .mockResolvedValueOnce({
        ok: false,
        refusal: {
          code: 'agent_session_operation_invalid',
          forkReason: 'provider-refused',
          message:
            'Claude Code returned an error result: No message found with message.uuid of: 0e99dedf'
        }
      })
      .mockResolvedValueOnce({ ok: true, value: { sessionId: 'child' } })
    // The generic sentence told the user to RETRY a deterministic rejection retrying cannot fix.
    await expect(forkStructuredSessionFromTurn(args)).rejects.toThrow('No message found with')
    await expect(forkStructuredSessionFromTurn(args)).resolves.toBe('child')
    // Settled means no child was minted, so the retry is allowed a fresh id.
    expect(call.mock.calls[1]?.[2].envelope.sessionId).not.toBe(
      call.mock.calls[0]?.[2].envelope.sessionId
    )
  })

  it('surfaces the pre-request capability guard instead of an unconfirmed outcome', async () => {
    const args = input()
    call
      .mockRejectedValueOnce(new CapabilityError('Forking requires a newer Orca server.'))
      .mockResolvedValueOnce({ ok: true, value: { sessionId: 'child' } })
    await expect(forkStructuredSessionFromTurn(args)).rejects.toThrow('newer Orca server')
    // Nothing was sent, so the retired attempt must not replay the abandoned child id.
    await forkStructuredSessionFromTurn(args)
    expect(call.mock.calls[1]?.[2].envelope.sessionId).not.toBe(
      call.mock.calls[0]?.[2].envelope.sessionId
    )
  })

  it('evicts the oldest unconfirmed attempt instead of wedging every later fork', async () => {
    call.mockRejectedValue(new Error('disconnected'))
    const first = input()
    await expect(forkStructuredSessionFromTurn(first)).rejects.toThrow('could not be confirmed')
    for (let index = 0; index < 200; index += 1) {
      await expect(forkStructuredSessionFromTurn(input())).rejects.toThrow('could not be confirmed')
    }
    call.mockReset()
    call.mockResolvedValue({ ok: true, value: { sessionId: 'child' } })
    // The 202nd fork in this app session must still reach the host.
    await forkStructuredSessionFromTurn(input())
    expect(call).toHaveBeenCalledTimes(1)
    // The evicted entry no longer replays, so the retry mints a fresh child id.
    await forkStructuredSessionFromTurn(first)
    expect(call.mock.calls[1]?.[2].envelope.sessionId).not.toBe(
      call.mock.calls[0]?.[2].envelope.sessionId
    )
  })
})
