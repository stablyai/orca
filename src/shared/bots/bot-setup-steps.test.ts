import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../native-chat/native-chat-types'
import { botSetupSteps } from './bot-setup-steps'

const retry: NativeChatMessage = {
  id: 'retry',
  role: 'system',
  blocks: [
    {
      type: 'text',
      text: 'Claude Code is retrying: Connection error. (attempt 3 of 10)',
      tone: 'warning'
    }
  ],
  timestamp: 2,
  source: 'transcript'
}
const read: NativeChatMessage = {
  id: 'read',
  role: 'assistant',
  blocks: [{ type: 'tool-call', name: 'Bash', input: { command: 'gh pr list' } }],
  timestamp: 3,
  source: 'transcript'
}

describe('botSetupSteps', () => {
  it('starts the agent, then runs the first message once the host says it is up', () => {
    expect(botSetupSteps({ turn: [], ended: false, agentReady: false, refused: null })).toEqual({
      start: { state: 'running' },
      reply: { state: 'pending' }
    })
    expect(botSetupSteps({ turn: [], ended: false, agentReady: true, refused: null })).toEqual({
      start: { state: 'done' },
      reply: { state: 'running' }
    })
  })

  it('shows the agent’s retry line while it is the latest, not once the turn moved on', () => {
    expect(botSetupSteps({ turn: [retry], ended: false, agentReady: true, refused: null })).toEqual(
      {
        start: { state: 'done' },
        reply: {
          state: 'running',
          detail: 'Claude Code is retrying: Connection error. (attempt 3 of 10)'
        }
      }
    )
    expect(
      botSetupSteps({ turn: [retry, read], ended: false, agentReady: true, refused: null })
    ).toEqual({ start: { state: 'done' }, reply: { state: 'running' } })
  })

  it('fails the first message with the turn’s last problem line when it ended without a word', () => {
    expect(
      botSetupSteps({ turn: [retry, read], ended: true, agentReady: true, refused: null })
    ).toEqual({
      start: { state: 'done' },
      reply: {
        state: 'failed',
        detail: 'Claude Code is retrying: Connection error. (attempt 3 of 10)'
      }
    })
  })

  it('fails the agent’s start with the host’s reason when the kickoff was refused', () => {
    expect(
      botSetupSteps({
        turn: [],
        ended: true,
        agentReady: false,
        refused: 'Claude Code is not signed in.'
      })
    ).toEqual({
      start: { state: 'failed', detail: 'Claude Code is not signed in.' },
      reply: { state: 'pending' }
    })
  })
})
