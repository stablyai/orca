import { describe, expect, it } from 'vitest'
import { AGENT_PROMPT_SUBMISSION_HISTORY_MAX } from '../../../../shared/agent-status-types'
import { createTestStore } from './store-test-helpers'

describe('agent prompt submission occurrences', () => {
  it('preserves a bounded deduped history through later status updates', () => {
    const store = createTestStore()
    const paneKey = 'tab-1:1'

    for (let sequence = 1; sequence <= AGENT_PROMPT_SUBMISSION_HISTORY_MAX + 2; sequence += 1) {
      store.getState().setAgentStatus(paneKey, {
        state: 'working',
        prompt: `prompt ${sequence}`,
        agentType: 'codex',
        promptSubmission: {
          streamId: 'stream-1',
          sequence,
          digest: `sha256:${String(sequence).padStart(64, '0')}`,
          receivedAt: sequence
        }
      })
    }

    const bounded = store.getState().agentStatusByPaneKey[paneKey].promptSubmissions
    expect(bounded?.map((occurrence) => occurrence.sequence)).toEqual(
      Array.from({ length: AGENT_PROMPT_SUBMISSION_HISTORY_MAX }, (_, index) => index + 3)
    )

    store.getState().setAgentStatus(paneKey, {
      state: 'working',
      prompt: 'tool update',
      agentType: 'codex',
      toolName: 'Read'
    })
    expect(store.getState().agentStatusByPaneKey[paneKey].promptSubmissions).toBe(bounded)

    const duplicate = bounded?.at(-1)
    if (!duplicate) {
      throw new Error('expected bounded prompt submission history')
    }
    store.getState().setAgentStatus(paneKey, {
      state: 'working',
      prompt: 'duplicate delivery',
      agentType: 'codex',
      promptSubmission: duplicate
    })
    expect(store.getState().agentStatusByPaneKey[paneKey].promptSubmissions).toBe(bounded)
  })
})
