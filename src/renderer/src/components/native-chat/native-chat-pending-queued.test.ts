import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { pendingSendsAsMessages, type NativeChatPendingSend } from './native-chat-pending'

function pendingOf(id: string, text: string): NativeChatPendingSend {
  return {
    id,
    text,
    sentAt: 100,
    afterMessageId: null
  }
}

function userMessage(id: string, text: string, timestamp = 1): NativeChatMessage {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text }],
    timestamp,
    source: 'transcript'
  }
}

function assistantMessage(id: string, text: string, timestamp = 1): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    timestamp,
    source: 'transcript'
  }
}

describe('pendingSendsAsMessages queued evaluation', () => {
  it('maps queued true onto output NativeChatMessage', () => {
    const pending = [
      {
        ...pendingOf('queued-send', 'later'),
        queued: true
      }
    ]
    const messages = pendingSendsAsMessages(pending)
    expect(messages[0]?.queued).toBe(true)
  })

  it('evaluates queued dynamically relative to queuedBehindWorkingEpoch, hookWorkingEpoch, and liveWorking', () => {
    const triggeringSend = {
      ...pendingOf('p1', 'active turn prompt'),
      sentAt: 1_000,
      queuedBehindWorkingEpoch: null
    }
    const followUpSend = {
      ...pendingOf('p2', 'follow-up prompt'),
      sentAt: 2_500,
      queuedBehindWorkingEpoch: 2_000
    }
    const active = pendingSendsAsMessages([triggeringSend, followUpSend], [], {
      liveWorking: true,
      hookWorkingEpoch: 2_000
    })
    expect(active[0]?.queued).toBeUndefined()
    expect(active[1]?.queued).toBe(true)

    // When turn advances to 3_000, follow-up 1 is active, but follow-up 2 stays queued
    const followUpSend2 = {
      ...pendingOf('p3', 'second follow-up'),
      sentAt: 2_600,
      queuedBehindWorkingEpoch: 2_000
    }
    const advancedEpoch = pendingSendsAsMessages([followUpSend, followUpSend2], [], {
      liveWorking: true,
      hookWorkingEpoch: 3_000
    })
    expect(advancedEpoch[0]?.queued).toBeUndefined()
    expect(advancedEpoch[1]?.queued).toBe(true)

    // Scenario A: first follow-up's user row landed, but second follow-up remains queued
    const followUp1Landed = [{ ...userMessage('u2', 'follow-up prompt'), timestamp: 2_500 }]
    const scenarioA = pendingSendsAsMessages([followUpSend, followUpSend2], followUp1Landed, {
      liveWorking: true,
      hookWorkingEpoch: 3_000
    })
    expect(scenarioA).toHaveLength(1)
    expect(scenarioA[0]?.queued).toBe(true)

    // Scenario A (post-pruning): once the first follow-up is pruned from React pending state,
    // the remaining second follow-up still stays queued behind the active turn
    const scenarioAPostPruning = pendingSendsAsMessages([followUpSend2], followUp1Landed, {
      liveWorking: true,
      hookWorkingEpoch: 3_000
    })
    expect(scenarioAPostPruning).toHaveLength(1)
    expect(scenarioAPostPruning[0]?.queued).toBe(true)

    // When follow-up 1 completes (assistant reply landed), follow-up 2 becomes the active turn
    const followUp1Completed = [
      ...followUp1Landed,
      { ...assistantMessage('a2', 'reply to first prompt'), timestamp: 3_500 }
    ]
    const followUp2Active = pendingSendsAsMessages([followUpSend2], followUp1Completed, {
      liveWorking: true,
      hookWorkingEpoch: 4_000
    })
    expect(followUp2Active[0]?.queued).toBeUndefined()

    // Scenario B: older echo lingers ahead of active follow-up
    const scenarioB = pendingSendsAsMessages([triggeringSend, followUpSend], [], {
      liveWorking: true,
      hookWorkingEpoch: 3_000
    })
    expect(scenarioB[0]?.queued).toBeUndefined()
    expect(scenarioB[1]?.queued).toBeUndefined()

    // A prompt queued while working remains queued when agent is live working, even if hookWorkingEpoch is null
    const noEpochQueued = pendingSendsAsMessages([{ ...followUpSend, queued: true }], [], {
      liveWorking: true,
      hookWorkingEpoch: null
    })
    expect(noEpochQueued[0]?.queued).toBe(true)

    // An initial prompt sent when idle is never queued, even if hookWorkingEpoch is null
    const noEpochTriggering = pendingSendsAsMessages([triggeringSend], [], {
      liveWorking: true,
      hookWorkingEpoch: null
    })
    expect(noEpochTriggering[0]?.queued).toBeUndefined()

    const notWorking = pendingSendsAsMessages([followUpSend], [], {
      liveWorking: false,
      hookWorkingEpoch: 2_000
    })
    expect(notWorking[0]?.queued).toBeUndefined()
  })

  it('does not flag a triggering prompt as queued when host clock lags client clock', () => {
    const now = 1_700_000_030_000
    const laggingHostEpoch = now - 30_000
    const triggeringPrompt = {
      ...pendingOf('trigger', 'prompt that triggered turn'),
      sentAt: now,
      queuedBehindWorkingEpoch: null
    }
    const messages = pendingSendsAsMessages([triggeringPrompt], [], {
      liveWorking: true,
      hookWorkingEpoch: laggingHostEpoch
    })
    expect(messages[0]?.queued).toBeUndefined()
  })
})
