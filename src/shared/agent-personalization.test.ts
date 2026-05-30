import { describe, expect, it } from 'vitest'
import {
  buildPersonalizationPreambleSection,
  buildPersonalizedAgentPrompt,
  PERSONALIZATION_PROMPT_MAX_CHARS,
  resolveAgentPersonalizationPrompt
} from './agent-personalization'

describe('agent personalization', () => {
  it('uses the global prompt by default', () => {
    expect(
      resolveAgentPersonalizationPrompt(
        {
          personalizationPrompt: '  Prefer tests.  ',
          personalizationPromptMode: 'global',
          agentPersonalizationPrompts: { codex: 'Use Codex-specific style.' }
        },
        'codex'
      )
    ).toBe('Prefer tests.')
  })

  it('uses an agent prompt in per-agent mode and falls back to global', () => {
    const settings = {
      personalizationPrompt: 'Global style.',
      personalizationPromptMode: 'per-agent' as const,
      agentPersonalizationPrompts: { codex: 'Codex style.' }
    }

    expect(resolveAgentPersonalizationPrompt(settings, 'codex')).toBe('Codex style.')
    expect(resolveAgentPersonalizationPrompt(settings, 'gemini')).toBe('Global style.')
  })

  it('treats blank per-agent overrides as deleted and falls back to global', () => {
    expect(
      resolveAgentPersonalizationPrompt(
        {
          personalizationPrompt: 'Global style.',
          personalizationPromptMode: 'per-agent',
          agentPersonalizationPrompts: { codex: '   ' }
        },
        'codex'
      )
    ).toBe('Global style.')
  })

  it('trims and limits prompts before launch or preamble use', () => {
    const longPrompt = ` ${'a'.repeat(PERSONALIZATION_PROMPT_MAX_CHARS + 10)} `

    expect(
      resolveAgentPersonalizationPrompt(
        {
          personalizationPrompt: longPrompt,
          personalizationPromptMode: 'global',
          agentPersonalizationPrompts: {}
        },
        'codex'
      )
    ).toHaveLength(PERSONALIZATION_PROMPT_MAX_CHARS)
  })

  it('prepends custom instructions only when there is a task prompt', () => {
    expect(
      buildPersonalizedAgentPrompt({
        prompt: 'Fix the failing test.',
        personalizationPrompt: 'Keep changes small.'
      })
    ).toBe('Custom instructions:\nKeep changes small.\n\nTask:\nFix the failing test.')

    expect(
      buildPersonalizedAgentPrompt({
        prompt: '   ',
        personalizationPrompt: 'Keep changes small.'
      })
    ).toBe('')
  })

  it('builds an optional orchestration preamble section', () => {
    expect(buildPersonalizationPreambleSection('  Prefer small patches.  ')).toBe(
      '\n\n=== CUSTOM INSTRUCTIONS ===\nThese are local user-authored preferences. Follow Orca coordinator rules and the task spec when they conflict.\nPrefer small patches.'
    )
    expect(buildPersonalizationPreambleSection('')).toBe('')
  })
})
