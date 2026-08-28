import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  enqueueNativeChatPtySend,
  resetNativeChatPtySendQueuesForTests
} from './native-chat-pty-send-queue'
import { waitForNativeChatSendQueueIdle } from './native-chat-send-settlement'

const PTY_ID = 'pty-1'

function enqueueTimedSend(durationMs: number) {
  return enqueueNativeChatPtySend(PTY_ID, durationMs, ({ delay, markSubmitted }) => {
    delay(durationMs, markSubmitted)
  })
}

describe('waitForNativeChatSendQueueIdle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetNativeChatPtySendQueuesForTests()
  })

  afterEach(() => {
    resetNativeChatPtySendQueuesForTests()
    vi.useRealTimers()
  })

  it('waits for a later send queued behind the revealing command', async () => {
    const revealingSend = enqueueTimedSend(10)
    const queueIdle = waitForNativeChatSendQueueIdle(PTY_ID, revealingSend.settled)
    enqueueTimedSend(20)
    let resolved = false
    void queueIdle?.then(() => {
      resolved = true
    })

    await vi.advanceTimersByTimeAsync(29)
    expect(resolved).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    expect(resolved).toBe(true)
  })

  it('waits for sends appended while an earlier successor is draining', async () => {
    const revealingSend = enqueueTimedSend(10)
    enqueueTimedSend(20)
    const queueIdle = waitForNativeChatSendQueueIdle(PTY_ID, revealingSend.settled)
    let resolved = false
    void queueIdle?.then(() => {
      resolved = true
    })

    await vi.advanceTimersByTimeAsync(15)
    enqueueTimedSend(30)
    await vi.advanceTimersByTimeAsync(15)
    expect(resolved).toBe(false)

    await vi.advanceTimersByTimeAsync(29)
    expect(resolved).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    expect(resolved).toBe(true)
  })
})
