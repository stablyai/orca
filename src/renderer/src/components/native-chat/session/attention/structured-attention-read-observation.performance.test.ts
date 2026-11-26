import { expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { EMPTY_STRUCTURED_AGENT_SESSION } from '../../../../../../shared/agent-session/view/live-read/structured-agent-session-reducer'
import { projectStructuredAgentSessionStatusSummary } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import * as promptProjection from '../../../../../../shared/agent-session/requests/structured-agent-session-latest-request'
import { connectorAskerPrompt } from '../../../../../../shared/connector-asker-prompt'
import { structuredAttentionReadObservation } from './structured-attention-read-observation'

function request(text: string): AgentJournalRenderItem {
  return {
    itemId: 'user',
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body: {
      kind: 'message',
      role: 'user',
      origin: 'connector',
      blocks: [
        {
          type: 'text',
          text: connectorAskerPrompt('slack', {
            userId: 'U1',
            role: 'owner',
            place: { kind: 'public_channel', id: 'C1' },
            context: [],
            text: text + 'x'.repeat(64 * 1024)
          })
        },
        { type: 'image-ref', path: '/fixture/image.png' }
      ]
    }
  }
}

it.each([10, 100])('does not unpack the request during %d tool updates', (updates) => {
  const format = vi.spyOn(promptProjection, 'latestStructuredAgentSessionPrompt')
  const prompt = request('First question ')
  try {
    const key = structuredAttentionReadObservation({
      ...EMPTY_STRUCTURED_AGENT_SESSION,
      items: [prompt]
    })
    for (let revision = 1; revision <= updates; revision += 1) {
      const tool: AgentJournalRenderItem = {
        itemId: 'tool',
        revision,
        sequence: 2,
        observedAt: 2,
        body: {
          kind: 'tool-call',
          name: 'shell',
          callId: 'tool',
          input: { detail: String(revision) },
          state: 'running'
        }
      }
      expect(
        structuredAttentionReadObservation({
          ...EMPTY_STRUCTURED_AGENT_SESSION,
          items: [prompt, tool]
        })
      ).toBe(key)
    }
    expect(format).not.toHaveBeenCalled()
    const summary = projectStructuredAgentSessionStatusSummary([request('New question ')])
    expect(summary.latestPrompt).toMatch(/^New question /)
    expect(format).toHaveBeenCalledTimes(1)
  } finally {
    format.mockRestore()
  }
})
