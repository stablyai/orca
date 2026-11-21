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
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: false,
        isRemote: false,
        title: 'zsh',
        hookAgent: null,
        launchAgent: 'codex'
      })
    ).toBe('codex')
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

  it.each([
    { title: '⠋ Fix the codex plugin launcher', isRemote: false },
    {
      title: '⠙ add grok support to the tab bar',
      isRemote: false,
      focusedCompletedHookAgent: 'claude' as const
    },
    { title: '⠹ port the gemini status parser', isRemote: true }
  ])('keeps Claude ownership for task text: $title', (signals) => {
    expect(
      resolveTabAgentFromSignals({
        ...signals,
        hasObservedAgentSignal: true,
        hookAgent: null,
        launchAgent: 'claude'
      })
    ).toBe('claude')
  })

  it('allows a newer explicit identity title to take ownership', () => {
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
