import { expect, it } from 'vitest'
import { createTestStore } from './store-test-helpers'
import { normalizeHookPayload } from '../../../../shared/agent-hook-listener'
import { createHookListenerState } from '../../../../shared/agent-hook-listener/listener-state'
import { inheritAgentResumeIdentity } from '../../../../shared/agent-resume-identity'
import type { AgentHookEventPayload } from '../../../../shared/agent-hook-listener/listener-event'

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'

function hookEvent(source: 'claude' | 'codex', sessionId: string): AgentHookEventPayload {
  const event = normalizeHookPayload(
    createHookListenerState(),
    source,
    {
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      launchToken: 'owner-launch',
      payload: { hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt: 'work' }
    },
    'production'
  )
  if (!event) {
    throw new Error('Hook was not normalized')
  }
  return event
}

it('keeps the owner session from the host row with no renderer-side ownership rule', () => {
  const store = createTestStore()
  const owner = inheritAgentResumeIdentity(hookEvent('claude', 'claude-owner'), undefined, 'claude')
  // The host resolves a nested child to the active owner's display agent before publishing the row.
  const child = inheritAgentResumeIdentity(hookEvent('codex', 'codex-child'), owner, 'claude')
  for (const row of [owner, child]) {
    store
      .getState()
      .setAgentStatus(
        PANE,
        row.payload,
        undefined,
        { updatedAt: Date.now() },
        { tabId: 'tab-1', worktreeId: 'wt-1' },
        { providerSession: row.providerSession, launchToken: 'owner-launch' }
      )
  }
  const expected = {
    key: 'session_id',
    id: 'claude-owner',
    resumeIdentity: { agent: 'claude' }
  }
  expect(store.getState().agentStatusByPaneKey[PANE]).toMatchObject({
    agentType: 'claude',
    providerSession: expected
  })
  store.getState().captureAllSleepingAgentSessions('quit')
  expect(store.getState().sleepingAgentSessionsByPaneKey[PANE]).toMatchObject({
    agent: 'claude',
    providerSession: expected
  })
})
