import { describe, expect, it } from 'vitest'
import { createHookListenerState } from './listener-state'
import { withClaudeToolRequestId } from './claude-tool-request-identity'

describe('Claude open-call tracking', () => {
  it("reads a batch's calls once however many calls are open", () => {
    const readsFor = (openCalls: number): number => {
      const state = createHookListenerState()
      for (let index = 0; index < openCalls; index++) {
        withClaudeToolRequestId(state, 'pane', 'PreToolUse', {
          tool_name: 'Read',
          tool_input: { file_path: `/tmp/file-${index}` },
          tool_use_id: `toolu-open-${index}`
        })
      }
      let reads = 0
      const toolCalls = Array.from({ length: 1000 }, (_, index) => ({
        get tool_use_id() {
          reads++
          return `toolu-batch-${index}`
        }
      }))
      withClaudeToolRequestId(state, 'pane', 'PostToolBatch', { tool_calls: toolCalls })
      return reads
    }
    // Settling needs each listed call's ID once; the open calls are matched against that set.
    expect(readsFor(1)).toBe(1000)
    expect(readsFor(32)).toBe(readsFor(1))
  })
})
