import { describe, expect, it } from 'vitest'
import { nativeChatToolRunCategory } from './native-chat-tool-icon'

describe('nativeChatToolRunCategory', () => {
  it("groups OpenCode's subagent calls with other agents' subagent calls", () => {
    expect(nativeChatToolRunCategory([{ name: 'subagent' }, { name: 'Task' }])).toBe(
      'subAgentActivity'
    )
  })
})
