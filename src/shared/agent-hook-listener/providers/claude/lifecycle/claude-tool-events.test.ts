import { describe, expect, it } from 'vitest'
import { createHookListenerState } from '../../../listener-state'
import { normalizeClaudeEvent } from '../claude-events'

describe('Claude post-Stop plugin tool calls', () => {
  it('never invents working when a plugin tool call arrives with no cached lead state', () => {
    const state = createHookListenerState()
    const payload = normalizeClaudeEvent(state, 'PreToolUse', '', 'pane-1', {
      tool_name: 'Read',
      tool_use_id: 'toolu_plugin_abc123'
    })
    expect(payload).toBeNull()
    expect(state.claudeLeadStateByPaneKey.get('pane-1')).toBeUndefined()
  })

  it('restores done after a post-Stop plugin PermissionRequest is approved', () => {
    const state = createHookListenerState()
    normalizeClaudeEvent(state, 'UserPromptSubmit', 'hello', 'pane-1', {})
    normalizeClaudeEvent(state, 'Stop', '', 'pane-1', {})
    expect(state.claudeLeadStateByPaneKey.get('pane-1')?.state).toBe('done')

    const waiting = normalizeClaudeEvent(state, 'PermissionRequest', '', 'pane-1', {
      tool_name: 'Bash',
      tool_use_id: 'toolu_plugin_perm1'
    })
    expect(waiting?.state).toBe('waiting')

    const afterPost = normalizeClaudeEvent(state, 'PostToolUse', '', 'pane-1', {
      tool_name: 'Bash',
      tool_use_id: 'toolu_plugin_perm1'
    })
    expect(afterPost?.state).toBe('done')
    expect(state.claudeLeadStateByPaneKey.get('pane-1')?.state).toBe('done')
  })

  it('restores done after a post-Stop plugin AskUserQuestion is answered', () => {
    const state = createHookListenerState()
    normalizeClaudeEvent(state, 'UserPromptSubmit', 'hello', 'pane-2', {})
    normalizeClaudeEvent(state, 'Stop', '', 'pane-2', {})

    const waiting = normalizeClaudeEvent(state, 'PreToolUse', '', 'pane-2', {
      tool_name: 'AskUserQuestion',
      tool_use_id: 'toolu_plugin_ask1'
    })
    expect(waiting?.state).toBe('waiting')

    const afterAnswer = normalizeClaudeEvent(state, 'PostToolUse', '', 'pane-2', {
      tool_name: 'AskUserQuestion',
      tool_use_id: 'toolu_plugin_ask1'
    })
    expect(afterAnswer?.state).toBe('done')
    expect(state.claudeLeadStateByPaneKey.get('pane-2')?.state).toBe('done')
  })
})
