import { expect, it } from 'vitest'
import { firstStructuredAgentSessionPrompt } from './structured-agent-session-first-prompt'

it('renders a bot mention as readable text in the title seed', () => {
  const prompt = firstStructuredAgentSessionPrompt([
    {
      itemId: 'message',
      sequence: 1,
      revision: 1,
      observedAt: 1,
      body: {
        kind: 'message',
        role: 'user',
        blocks: [
          {
            type: 'text',
            text: 'ask [Bot: Eng - Nora](bot:52fbc8b4-69a9-4cf9-89ef-72499d00c3d7) to review the change'
          }
        ]
      }
    }
  ])
  expect(prompt).toBe('ask @Eng - Nora to review the change')
})
