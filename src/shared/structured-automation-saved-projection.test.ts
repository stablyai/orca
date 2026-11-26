import { describe, expect, it } from 'vitest'
import type { AgentJournalItemBody } from './agent-session/journal/agent-session-journal-types'
import { projectAutomationRunNotStartedItem } from './structured-automation-saved-projection'

const HOST_SENTENCE = 'Your Hermes CLI on this computer is 0.20.5. Chats need 0.23.0 or newer.'

function card(refusal: unknown) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a saved body as storage hands it back: a partial automation and a raw refusal.
  const body = {
    kind: 'automation-run-not-started',
    run: {
      runId: 'run-1',
      automation: { id: 'auto-1', name: 'Nightly triage' },
      trigger: 'scheduled',
      instructionsLength: 9
    },
    actsFor: [],
    error: HOST_SENTENCE,
    refusal,
    text: 'Say hello',
    at: 1
  } as unknown as AgentJournalItemBody
  return projectAutomationRunNotStartedItem({
    itemId: 'item-1',
    revision: 1,
    body,
    sequence: 1,
    observedAt: 1
  })?.automationRunNotStarted
}

describe('projectAutomationRunNotStartedItem', () => {
  it('keeps a refusal whose cause this build can word', () => {
    const refusal = {
      code: 'structured_agent_session_unsupported',
      details: {
        reason: 'hostUnsupported',
        agentInstallation: { agent: 'hermes', installedVersion: '0.20.5', minimumVersion: '0.23.0' }
      }
    }
    expect(card(refusal)?.refusal).toEqual(refusal)
  })

  it("leaves a newer host's reason to its own sentence", () => {
    // A reason this build does not know reads as none, which would only say the agent couldn't start.
    const shown = card({
      code: 'agent_session_operation_invalid',
      details: { reason: 'aReasonFromANewerHost' }
    })
    expect(shown?.refusal).toBeUndefined()
    expect(shown?.error).toBe(HOST_SENTENCE)
  })
})
