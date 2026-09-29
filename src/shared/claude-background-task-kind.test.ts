import { describe, expect, it } from 'vitest'
import { classifyClaudeBackgroundTaskKind } from './claude-background-task-kind'

describe('classifyClaudeBackgroundTaskKind', () => {
  it('classifies the SDK stream vocabulary', () => {
    expect(classifyClaudeBackgroundTaskKind('local_agent')).toBe('agent')
    expect(classifyClaudeBackgroundTaskKind('local_subagent')).toBe('agent')
    expect(classifyClaudeBackgroundTaskKind('local_workflow')).toBe('workflow')
    expect(classifyClaudeBackgroundTaskKind('local_bash')).toBe('command')
    expect(classifyClaudeBackgroundTaskKind('monitor')).toBe('monitor')
  })

  it('classifies the hook inventory vocabulary onto the same kinds', () => {
    expect(classifyClaudeBackgroundTaskKind('subagent')).toBe('agent')
    expect(classifyClaudeBackgroundTaskKind('teammate')).toBe('agent')
    expect(classifyClaudeBackgroundTaskKind('shell')).toBe('command')
    expect(classifyClaudeBackgroundTaskKind('background_shell')).toBe('command')
  })

  it('fails unknown and malformed types to unknown, never to agent', () => {
    expect(classifyClaudeBackgroundTaskKind('future_task')).toBe('unknown')
    expect(classifyClaudeBackgroundTaskKind(undefined)).toBe('unknown')
    expect(classifyClaudeBackgroundTaskKind(42)).toBe('unknown')
  })
})
