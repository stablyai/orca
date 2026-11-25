import { describe, expect, it } from 'vitest'
import { AGENT_SESSION_RESTART_WORK_CONTINUATION_MESSAGE } from '../agent-session/lifecycle/stopping/agent-session-restart-continuation'
import { handedAgentRows, type BotHandedAgentObservation } from './bot-activity-handed-agents'

const agent = (
  entry: Partial<BotHandedAgentObservation['entry']>,
  fields: Partial<BotHandedAgentObservation> = {}
): BotHandedAgentObservation => ({
  paneKey: 'tab-1:leaf-1',
  entry: { state: 'working', prompt: '', stateStartedAt: 1, ...entry },
  worktreeId: 'repo::/work/fix-login',
  ...fields
})

describe('an agent handed to the bot', () => {
  it('is never titled by a prompt Orca wrote', () => {
    const mail = '──── From: ORCA_SESSION_ID:abc (orca_session_id:abc) (handoff) ────\nSubject: x'
    const [titled, restarted] = handedAgentRows([
      agent({ prompt: mail }, { title: 'Fix the login redirect' }),
      agent({ prompt: AGENT_SESSION_RESTART_WORK_CONTINUATION_MESSAGE })
    ])
    expect(titled.title).toBe('Fix the login redirect')
    expect(restarted.title).toBe('fix-login')
  })

  it("keeps its interactive tool question in the owner's Needs you, titled by the question", () => {
    const [asking] = handedAgentRows([
      agent({
        state: 'waiting',
        toolName: 'AskUserQuestion',
        prompt: '──── From: BOT (bot) (handoff) ────',
        interactivePrompt: JSON.stringify({
          questions: [{ question: 'Deploy to staging?', options: [{ label: 'Yes' }] }]
        })
      })
    ])
    expect(asking.dot).toBe('waiting')
    expect(asking.title).toBe('Deploy to staging?')
  })
})
