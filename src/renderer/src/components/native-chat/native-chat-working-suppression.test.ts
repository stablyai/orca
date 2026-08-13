import { describe, expect, it } from 'vitest'
import {
  latestNativeChatUserTurnKey,
  shouldSuppressNativeChatWorking,
  shouldShowNativeChatWorking
} from './native-chat-working-suppression'

const interruption = {
  paneKey: 'tab-1:1',
  agent: 'claude' as const,
  sessionId: 'session-1',
  workingEpoch: 10,
  userTurnKey: 'turn-1'
}

describe('native chat working suppression', () => {
  it('hides stale working state after a user interrupt', () => {
    expect(
      shouldShowNativeChatWorking({
        isConversation: true,
        working: true,
        interrupted: true
      })
    ).toBe(false)
  })

  it('shows working before an interrupt', () => {
    expect(
      shouldShowNativeChatWorking({
        isConversation: true,
        working: true,
        interrupted: false
      })
    ).toBe(true)
  })

  it('stops suppressing after reconciled working clears', () => {
    expect(
      shouldSuppressNativeChatWorking({
        ...interruption,
        working: false,
        interruption
      })
    ).toBe(false)
  })

  it('stops suppressing when a newer working epoch starts', () => {
    expect(
      shouldSuppressNativeChatWorking({
        ...interruption,
        working: true,
        workingEpoch: 20,
        interruption
      })
    ).toBe(false)
    expect(
      shouldSuppressNativeChatWorking({
        ...interruption,
        working: true,
        workingEpoch: 10,
        interruption
      })
    ).toBe(true)
    expect(
      shouldSuppressNativeChatWorking({
        ...interruption,
        working: true,
        workingEpoch: 5,
        interruption
      })
    ).toBe(true)
  })

  it('stops suppressing when the conversation changes', () => {
    expect(
      shouldSuppressNativeChatWorking({
        ...interruption,
        working: true,
        sessionId: 'session-2',
        interruption
      })
    ).toBe(false)
  })

  it('keeps suppression when an initially unknown session id hydrates', () => {
    const sessionPendingInterruption = { ...interruption, sessionId: null }
    expect(
      shouldSuppressNativeChatWorking({
        ...interruption,
        working: true,
        interruption: sessionPendingInterruption
      })
    ).toBe(true)
  })

  it('keeps suppressing when the interrupted epoch only gains its transcript id', () => {
    expect(
      shouldSuppressNativeChatWorking({
        ...interruption,
        working: true,
        userTurnKey: 'turn-2',
        interruption
      })
    ).toBe(true)
  })

  it('falls back to user-turn identity when the working epoch is unavailable', () => {
    const noEpochInterruption = { ...interruption, workingEpoch: null }
    expect(
      shouldSuppressNativeChatWorking({
        ...noEpochInterruption,
        working: true,
        interruption: noEpochInterruption
      })
    ).toBe(true)
    expect(
      shouldSuppressNativeChatWorking({
        ...noEpochInterruption,
        working: true,
        userTurnKey: 'turn-2',
        interruption: noEpochInterruption
      })
    ).toBe(false)
  })

  it('uses the latest user turn id as the fallback identity', () => {
    expect(
      latestNativeChatUserTurnKey([
        {
          id: 'user-1',
          turnId: 'turn-1',
          role: 'user',
          blocks: [],
          timestamp: 1,
          source: 'transcript'
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          blocks: [],
          timestamp: 2,
          source: 'transcript'
        }
      ])
    ).toBe('turn-1')
  })
})
