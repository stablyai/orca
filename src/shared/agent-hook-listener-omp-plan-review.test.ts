import { beforeEach, describe, expect, it } from 'vitest'
import {
  createHookListenerState,
  seedLegacyAgentStatusForTests,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import { normalizeHookPayload } from './agent-hook-listener'
import { PANE_KEY } from './agent-hook-listener-test-harness'
import { AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH } from './agent-status-types'
import { parseOmpPlanReviewPrompt } from './omp-plan-review-prompt'

const REVIEW_ID = '86949d10-20aa-46d4-9359-4e1e71467d8f'

function post(state: HookListenerState, payload: Record<string, unknown>) {
  return normalizeHookPayload(state, 'omp', { paneKey: PANE_KEY, payload }, 'production')?.payload
}

function requestReview(state: HookListenerState, plan: string) {
  return post(state, {
    hook_event_name: 'plan_review_requested',
    review_id: REVIEW_ID,
    plan,
    options: [
      { id: 'execute', label: 'Approve and execute' },
      { id: 'refine', label: 'Refine plan' },
      { id: 'save', label: 'Save and quit' }
    ]
  })
}

describe('OMP plan review status', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  it('clips a long plan so the card still parses', () => {
    const blocked = requestReview(state, `"quoted"\n${'x'.repeat(40_000)}`)

    expect(blocked?.interactivePrompt?.length).toBeLessThanOrEqual(
      AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH
    )
    expect(parseOmpPlanReviewPrompt(blocked?.interactivePrompt)?.plan).toMatch(
      /^"quoted"\nx+\n\n…$/
    )
  })

  it("keeps the card when an earlier turn's last async child ends under the review", () => {
    const deliver = (payload: Record<string, unknown>) => {
      const event = normalizeHookPayload(state, 'omp', { paneKey: PANE_KEY, payload }, 'production')
      if (event) {
        seedLegacyAgentStatusForTests(state, event)
      }
      return state.lastStatusByPaneKey.get(PANE_KEY)?.payload
    }
    deliver({
      hook_event_name: 'plan_review_requested',
      review_id: REVIEW_ID,
      plan: '# Plan',
      options: [{ id: 'execute', label: 'Approve and execute' }]
    })

    const held = deliver({ hook_event_name: 'agent_end' })
    expect(held?.state).toBe('blocked')
    expect(parseOmpPlanReviewPrompt(held?.interactivePrompt)?.reviewId).toBe(REVIEW_ID)
    expect(deliver({ hook_event_name: 'agent_end', session_boundary: true })?.state).toBe('done')
  })
})
