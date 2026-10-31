import { describe, expect, it } from 'vitest'
import { hasObservedTabAgentSignal, resolveTabAgentFromSignals } from './tab-agent-from-signals'

describe('tab agent task-title identity', () => {
  it('does not arm launch exit clearing from an agent mention in task text', () => {
    expect(
      hasObservedTabAgentSignal({
        title: 'Fix the codex launcher',
        launchAgent: 'codex',
        hasCompletedHook: false
      })
    ).toBe(false)
    expect(
      hasObservedTabAgentSignal({
        title: 'Codex',
        launchAgent: 'codex',
        hasCompletedHook: false
      })
    ).toBe(true)
  })

  it.each([
    ['◇ Qoder CLI CN', 'qoder-cn'],
    ['tmux | Grok', 'grok'],
    [`${'x | '.repeat(9)}OC | Current task`, 'opencode']
  ] as const)(
    'observes canonical native identity %s for launch exit clearing',
    (title, launchAgent) => {
      expect(hasObservedTabAgentSignal({ title, launchAgent, hasCompletedHook: false })).toBe(true)
    }
  )

  it('keeps a Claude-owned pane Claude when its task title mentions another agent', () => {
    for (const title of [
      '⠋ Fix the codex plugin launcher',
      '⠙ add grok support to the tab bar',
      '⠹ port the gemini status parser'
    ]) {
      for (const signals of [
        { hasObservedAgentSignal: true, isRemote: false },
        {
          hasObservedAgentSignal: true,
          isRemote: false,
          focusedCompletedHookAgent: 'claude' as const
        },
        { hasObservedAgentSignal: true, isRemote: true }
      ]) {
        expect(
          resolveTabAgentFromSignals({
            ...signals,
            title,
            hookAgent: null,
            launchAgent: 'claude'
          })
        ).toBe('claude')
      }
    }

    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: '⠋ Codex: fix cursor offsets',
        hookAgent: null,
        launchAgent: 'claude'
      })
    ).toBe('codex')
  })
})
