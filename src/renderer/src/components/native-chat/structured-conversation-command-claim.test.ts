import { describe, expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import {
  StructuredConversationCommandClaim,
  type ConversationCommandReply
} from './structured-conversation-command-claim'

const OPERATION_ID = 'op-1'

function lifecycleItem(
  command: 'clear' | 'compact',
  state: 'running' | 'completed' | 'unverifiable',
  text?: string
): AgentJournalRenderItem {
  return {
    itemId: agentJournalSubmissionKey(`${command}:${OPERATION_ID}`),
    revision: state === 'running' ? 1 : 2,
    sequence: 1,
    observedAt: 1,
    body: {
      kind: 'status',
      text:
        text ??
        (state === 'running'
          ? `${command === 'compact' ? 'Compacting' : 'Clearing'} conversation…`
          : command === 'compact'
            ? 'Conversation compacted.'
            : 'Conversation cleared.'),
      turnLifecycle: { turnId: `${command}:${OPERATION_ID}`, state }
    }
  }
}

function neverReplies(): Promise<ConversationCommandReply> {
  return new Promise<ConversationCommandReply>(() => {})
}

describe('StructuredConversationCommandClaim', () => {
  it.each(['compact', 'clear'] as const)(
    'settles %s from typed host lifecycle when the reply is lost',
    async (command) => {
      const claim = new StructuredConversationCommandClaim()
      const outcome = claim.run({
        command,
        operationId: OPERATION_ID,
        blocked: false,
        send: neverReplies
      })
      expect(claim.applyStreamSnapshot([lifecycleItem(command, 'running')])).toEqual([])
      expect(claim.applyStreamSnapshot([lifecycleItem(command, 'completed')])).toEqual([
        OPERATION_ID
      ])
      await expect(outcome).resolves.toEqual({ accepted: true, error: null })
    }
  )

  it('settles an unverifiable host lifecycle with recovery guidance', async () => {
    const claim = new StructuredConversationCommandClaim()
    const outcome = claim.run({
      command: 'compact',
      operationId: OPERATION_ID,
      blocked: false,
      send: async () => ({ status: 'unresolved' })
    })
    await Promise.resolve()
    expect(claim.applyStreamSnapshot([lifecycleItem('compact', 'unverifiable')])).toEqual([
      OPERATION_ID
    ])
    await expect(outcome).resolves.toMatchObject({
      accepted: false,
      error: expect.stringContaining('Retry the command')
    })
    expect(claim.isRunning).toBe(false)
  })

  it('preserves a provider failure carried by terminal lifecycle', async () => {
    const claim = new StructuredConversationCommandClaim()
    const outcome = claim.run({
      command: 'compact',
      operationId: OPERATION_ID,
      blocked: false,
      send: neverReplies
    })
    claim.applyStreamSnapshot([
      lifecycleItem('compact', 'completed', 'Provider refused compaction.')
    ])
    await expect(outcome).resolves.toEqual({
      accepted: false,
      error: 'Provider refused compaction.'
    })
  })

  it('keeps waiting for lifecycle when transport returns no reply', async () => {
    const claim = new StructuredConversationCommandClaim()
    const settled = vi.fn()
    const outcome = claim
      .run({
        command: 'compact',
        operationId: OPERATION_ID,
        blocked: false,
        send: async () => ({ status: 'unresolved' })
      })
      .then((value) => {
        settled(value)
        return value
      })
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    expect(claim.isRunning).toBe(true)

    claim.applyStreamSnapshot([lifecycleItem('compact', 'completed')])
    await expect(outcome).resolves.toEqual({ accepted: true, error: null })
  })

  it('releases a host-confirmed unknown result for same-operation replay', async () => {
    const claim = new StructuredConversationCommandClaim()
    await expect(
      claim.run({
        command: 'compact',
        operationId: OPERATION_ID,
        blocked: false,
        send: async () => ({
          status: 'completed',
          result: { command: 'compact', state: 'unknown' }
        })
      })
    ).resolves.toMatchObject({ accepted: false, retrySameOperation: true })
    expect(claim.isRunning).toBe(false)
  })

  it('releases interaction at the deadline and allows same-operation replay', async () => {
    vi.useFakeTimers()
    try {
      const claim = new StructuredConversationCommandClaim(10)
      const outcome = claim.run({
        command: 'compact',
        operationId: OPERATION_ID,
        blocked: false,
        send: neverReplies
      })
      const settled = expect(outcome).resolves.toMatchObject({
        accepted: false,
        error: expect.stringContaining('Retry the command'),
        retrySameOperation: true
      })

      await vi.advanceTimersByTimeAsync(11)
      await settled
      expect(claim.isRunning).toBe(false)
      await expect(
        claim.run({
          command: 'compact',
          operationId: OPERATION_ID,
          blocked: false,
          send: async () => ({
            status: 'completed',
            result: { command: 'compact', state: 'completed' }
          })
        })
      ).resolves.toEqual({ accepted: true, error: null })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not let a reply from before reset settle a same-operation replay', async () => {
    const claim = new StructuredConversationCommandClaim()
    const firstReply = Promise.withResolvers<ConversationCommandReply>()
    const first = claim.run({
      command: 'clear',
      operationId: OPERATION_ID,
      blocked: false,
      send: () => firstReply.promise
    })

    claim.reset(true)
    await expect(first).resolves.toMatchObject({ accepted: false, retrySameOperation: true })

    const replayReply = Promise.withResolvers<ConversationCommandReply>()
    const replay = claim.run({
      command: 'clear',
      operationId: OPERATION_ID,
      blocked: false,
      send: () => replayReply.promise
    })
    firstReply.resolve({ status: 'refused', error: 'The old fence is stale.' })
    await Promise.resolve()
    expect(claim.isRunning).toBe(true)

    replayReply.resolve({
      status: 'completed',
      result: { command: 'clear', state: 'completed' }
    })
    await expect(replay).resolves.toEqual({ accepted: true, error: null })
  })

  it('drops the deadline observer after a bounded window', async () => {
    vi.useFakeTimers()
    try {
      const claim = new StructuredConversationCommandClaim(10)
      const outcome = claim.run({
        command: 'compact',
        operationId: OPERATION_ID,
        blocked: false,
        send: neverReplies
      })

      await vi.advanceTimersByTimeAsync(11)
      await outcome
      expect(claim.isOperationOutstanding(OPERATION_ID)).toBe(true)

      await vi.advanceTimersByTimeAsync(11)
      expect(claim.isOperationOutstanding(OPERATION_ID)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses replies from older hosts that publish no typed lifecycle', async () => {
    const claim = new StructuredConversationCommandClaim()
    await expect(
      claim.run({
        command: 'clear',
        operationId: OPERATION_ID,
        blocked: false,
        send: async () => ({
          status: 'completed',
          result: { command: 'clear', state: 'completed' }
        })
      })
    ).resolves.toEqual({ accepted: true, error: null })
  })

  it('refuses a concurrent command without sending it', async () => {
    const claim = new StructuredConversationCommandClaim()
    const send = vi.fn(neverReplies)
    void claim.run({ command: 'compact', operationId: OPERATION_ID, blocked: false, send })
    await expect(
      claim.run({ command: 'clear', operationId: 'op-2', blocked: false, send })
    ).resolves.toMatchObject({ accepted: false })
    expect(send).toHaveBeenCalledTimes(1)
    claim.reset()
  })

  it('returns a definitive refusal without retaining retry ownership', async () => {
    const claim = new StructuredConversationCommandClaim()
    await expect(
      claim.run({
        command: 'compact',
        operationId: OPERATION_ID,
        blocked: false,
        send: async () => ({ status: 'refused', error: 'Wait for pending work.' })
      })
    ).resolves.toEqual({ accepted: false, error: 'Wait for pending work.' })
    expect(claim.isOperationOutstanding(OPERATION_ID)).toBe(false)
  })
})
