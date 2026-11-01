import { expect, it } from 'vitest'
import { cliConversationExitGuidance } from './cli-conversation-exit-guidance'

// Once the agent quits, an older host drops the pane's row and its Continue button, so the
// refusal must point to the Session History route that still opens the conversation.
it('sends a refusal in this terminal to Session History', () => {
  expect(cliConversationExitGuidance('claude', true)).toBe(
    'Claude is still running this conversation in this terminal. Quit Claude here, then open this conversation from Session History.'
  )
})
