import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../native-chat/native-chat-types'
import { agentSessionFailureFact } from '../agent-session/failures/agent-session-failure'
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
        refused: { reason: 'Claude Code is not signed in.' }
      })
    ).toEqual({
      start: { state: 'failed', detail: 'Claude Code is not signed in.' },
      reply: { state: 'pending' }
    })
    // A host that gave no sentence still shows the agent's own words.
    expect(
      botSetupSteps({
        turn: [],
        ended: true,
        agentReady: false,
        refused: { reason: '', providerDetail: 'Error: CLAUDE_CODE_PLUGIN_DIRS is disabled' }
      }).start
    ).toEqual({ state: 'failed', providerDetail: 'Error: CLAUDE_CODE_PLUGIN_DIRS is disabled' })
  })

  it('keeps the agent’s own words on why it stopped starting, beside the sentence', () => {
    const stopped: NativeChatMessage = {
      id: 'stopped',
      role: 'system',
      blocks: [
        {
          type: 'text',
          text: 'Claude stopped before it finished starting. Send your message to try again.',
          tone: 'error',
          failure: agentSessionFailureFact('providerStartFailed', {
            detail: {
              text: '(code 1)\nError: CLAUDE_CODE_PLUGIN_DIRS is disabled',
              audience: 'log'
            }
          })
        }
      ],
      timestamp: 4,
      source: 'transcript'
    }
    expect(
      botSetupSteps({ turn: [stopped], ended: true, agentReady: false, refused: null })
    ).toEqual({
      start: {
        state: 'failed',
        detail: 'Claude stopped before it finished starting. Send your message to try again.',
        providerDetail: '(code 1)\nError: CLAUDE_CODE_PLUGIN_DIRS is disabled'
      },
      reply: { state: 'pending' }
    })
  })
})
