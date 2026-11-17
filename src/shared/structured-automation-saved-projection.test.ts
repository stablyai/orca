import { describe, expect, it } from 'vitest'

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

import { z } from 'zod'
import { projectStructuredOrcaCardItem, projectAutomationRunNotStartedItem } from './structured-automation-saved-projection'
import { projectStructuredItemToNativeChat } from './agent-session/view/structured-agent-session-projection'
import { isAdmissibleAgentJournalRenderItem } from './agent-session/journal/agent-session-journal-schemas'
import type { AgentJournalRenderItem, AgentJournalItemBody } from './agent-session/journal/agent-session-journal-types'
import { storedItem } from '../main/native-chat/agent-session-journal/durable-rows/journal-storage-schema'
import { strictStorage } from '../main/native-chat/agent-session-journal/durable-rows/journal-storage-strict'

const item: AgentJournalRenderItem = {
  itemId: 'orca:receipt',
  revision: 1,
  sequence: 2,
  observedAt: 100,
  body: {
    kind: 'automation-saved',
    change: 'created',
    automation: {
      id: 'a',
      name: 'Calendar reminder',
      enabled: true,
      nextRunAt: 0,
      updatedAt: 100,
      dtstart: 253370764800000,
      rrule: 'FREQ=DAILY',
      workspaceId: null,
      on: [{ id: 'c', source: 'calendar', event: 'starting_soon' }]
    },
    receiptFacts: {
      version: 1,
      automationCreatedAt: 10,
      zone: { kind: 'not-recorded' },
      triggerExtras: {
        coverage: 'complete',
        items: [
          {
            triggerId: 'c',
            additionalConditions: 'none',
            google: {
              kind: 'calendar',
              minutesBefore: 60,
              account: { kind: 'host-only' },
              calendar: 'primary'
            }
          }
        ]
      }
    }
  }
}

it('round-trips the saved delta through strict storage without breaking the existing shared reader', () => {
  const stored: unknown = strictStorage(storedItem).parse(JSON.parse(JSON.stringify(item)))
  if (!isAdmissibleAgentJournalRenderItem(stored)) {
    throw new Error('Unreadable journal item')
  }
  expect(projectStructuredOrcaCardItem(stored)?.automationSaved).toMatchObject({
    receiptFacts: {
      triggerExtras: {
        coverage: 'complete',
        items: [{ triggerId: 'c', google: { minutesBefore: 60 } }]
      }
    }
  })
  expect(projectStructuredItemToNativeChat(stored)).toBeNull()
})

it('consumes shortened and unsupported-reader evidence rather than claiming complete trigger facts', () => {
  expect(projectStructuredOrcaCardItem({ ...item, shortened: true })).toMatchObject({
    shortened: true,
    automationSaved: { receiptFacts: undefined }
  })
  expect(projectStructuredOrcaCardItem(item, false)?.automationSaved?.receiptFacts).toBeUndefined()
})

it('keeps future optional facts readable and compatible with the original saved-item decoder', () => {
  // The original public saved-body schema at 3f73ded4; older clients strip unknown keys.
  const legacy = z.object({
    kind: z.literal('automation-saved'),
    change: z.string().min(1),
    automation: z.object({ id: z.string().min(1), name: z.string() })
  })
  expect(legacy.parse(item.body)).toEqual({
    kind: 'automation-saved',
    change: 'created',
    automation: { id: 'a', name: 'Calendar reminder' }
  })
  const future = { ...item, body: { ...item.body, receiptFacts: { version: 2, other: true } } }
  expect(isAdmissibleAgentJournalRenderItem(future)).toBe(true)
  expect(projectStructuredOrcaCardItem(future)?.automationSaved?.receiptFacts).toBeUndefined()
})
