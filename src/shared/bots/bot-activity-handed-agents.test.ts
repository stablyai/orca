import { describe, expect, it } from 'vitest'
import { AGENT_SESSION_RESTART_WORK_CONTINUATION_MESSAGE } from '../agent-session/lifecycle/stopping/agent-session-restart-continuation'
import { CODEX_ASYNC_QUESTION_TOOL } from '../native-chat/input/questions/codex-async-question-input'
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

  it("leaves its open question to the bot, as a recorded worker's ask, but not a permission", () => {
    const [asking, permission] = handedAgentRows([
      agent({ state: 'waiting', toolName: CODEX_ASYNC_QUESTION_TOOL }),
      agent({ state: 'waiting', toolName: 'Bash' })
    ])
    expect(asking.dot).toBe('idle')
    expect(permission.dot).toBe('waiting')
  })
})
