import { describe, expect, it } from 'vitest'
import { classifyAgentSubmitSignal, harnessReportsSubmitSignal } from './agent-submit-signal'

describe('classifyAgentSubmitSignal', () => {
  it.each([
    ['claude', 'UserPromptSubmit'],
    ['kimi', 'UserPromptSubmit'],
    ['codex', 'UserPromptSubmit'],
    ['droid', 'UserPromptSubmit'],
    ['devin', 'UserPromptSubmit'],
    ['grok', 'user_prompt_submit'],
    ['copilot', 'userPromptSubmitted'],
    ['gemini', 'BeforeAgent'],
    ['antigravity', 'PreInvocation'],
    ['amp', 'agent.start'],
    ['cursor', 'beforeSubmitPrompt'],
    ['pi', 'before_agent_start'],
    ['omp', 'before_agent_start'],
    ['prime-agent', 'before_agent_start'],
    ['hermes', 'pre_llm_call']
  ] as const)('reads %s %s as a turn start', (source, hookEventName) => {
    expect(classifyAgentSubmitSignal(source, { hookEventName })).toBe('turn-start')
  })

  it('does not read a session start as a submit', () => {
    // Why: a restarted CLI emits SessionStart with no prompt behind it.
    expect(classifyAgentSubmitSignal('claude', { hookEventName: 'SessionStart' })).toBeNull()
    expect(classifyAgentSubmitSignal('codex', { hookEventName: 'SessionStart' })).toBeNull()
    expect(classifyAgentSubmitSignal('hermes', { hookEventName: 'on_session_start' })).toBeNull()
  })

  it('does not read tool traffic as a submit', () => {
    expect(classifyAgentSubmitSignal('claude', { hookEventName: 'PreToolUse' })).toBeNull()
    expect(classifyAgentSubmitSignal('claude', { hookEventName: 'Stop' })).toBeNull()
  })

  it('reads an OpenCode user message part as an acceptance, not a turn start', () => {
    expect(
      classifyAgentSubmitSignal('opencode', {
        hookEventName: 'MessagePart',
        hasExplicitPrompt: true
      })
    ).toBe('user-message')
    expect(
      classifyAgentSubmitSignal('mimo-code', {
        hookEventName: 'MessagePart',
        hasExplicitPrompt: true
      })
    ).toBe('user-message')
  })

  it('ignores an OpenCode message part that is not the user prompt', () => {
    expect(classifyAgentSubmitSignal('opencode', { hookEventName: 'MessagePart' })).toBeNull()
  })

  it('has no submit signal at all for Command Code', () => {
    // Why: its prompts come from re-reading the transcript on tool events, which can surface the
    // PREVIOUS turn's prompt — evidence too weak to claim a submit from.
    expect(harnessReportsSubmitSignal('command-code')).toBe(false)
    expect(classifyAgentSubmitSignal('command-code', { hookEventName: 'PreToolUse' })).toBeNull()
  })

  it('reports a submit signal for every other harness', () => {
    for (const source of ['claude', 'codex', 'opencode', 'grok', 'copilot'] as const) {
      expect(harnessReportsSubmitSignal(source)).toBe(true)
    }
  })

  it('ignores an event with no name', () => {
    expect(classifyAgentSubmitSignal('claude', {})).toBeNull()
  })
})
