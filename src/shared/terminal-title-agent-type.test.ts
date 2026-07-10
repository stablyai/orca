import { describe, expect, it } from 'vitest'
import {
  isGrokRotatingWorkingTitle,
  resolveExplicitTerminalTitleAgentType
} from './terminal-title-agent-type'

describe('isGrokRotatingWorkingTitle', () => {
  it('matches Grok working frames regardless of the rotating middle text', () => {
    expect(isGrokRotatingWorkingTitle('⠋ - Waiting for response… - grok')).toBe(true)
    expect(isGrokRotatingWorkingTitle('⠴ - Thinking - grok')).toBe(true)
    expect(isGrokRotatingWorkingTitle('⠦ - Sleep 2s then echo hello… - grok')).toBe(true)
    // Collapsed/stable form must stay matched so re-normalization is idempotent.
    expect(isGrokRotatingWorkingTitle('⠋ grok')).toBe(true)
    expect(isGrokRotatingWorkingTitle('⠋ Grok')).toBe(true)
  })

  it('ignores non-working, non-Grok, and lookalike titles', () => {
    expect(isGrokRotatingWorkingTitle('grok')).toBe(false) // idle bare name, no spinner
    expect(isGrokRotatingWorkingTitle('Fix the auth bug - grok')).toBe(false) // session title, no spinner
    expect(isGrokRotatingWorkingTitle('⠋ debugging grok - claude')).toBe(false) // trailing name is another agent
    expect(isGrokRotatingWorkingTitle('⠋ ~/grok-scratch/ready')).toBe(false) // path fragment, not a trailing token
    expect(isGrokRotatingWorkingTitle('⠋ grokking the plan')).toBe(false) // "grok" not a whole trailing token
    expect(isGrokRotatingWorkingTitle('⠋ Codex')).toBe(false)
    // Task text ending in "grok" is not the Grok frame shape "spinner - phrase - grok".
    expect(isGrokRotatingWorkingTitle('⠋ wire up grok')).toBe(false)
    expect(isGrokRotatingWorkingTitle('⠋ Codex is thinking about grok')).toBe(false)
    expect(isGrokRotatingWorkingTitle('⠋ support for Grok')).toBe(false)
    // Why: Claude/Codex braille + task can end with " - grok" without the
    // post-spinner delimiter that marks a real Grok Build frame.
    expect(isGrokRotatingWorkingTitle('⠋ fix the flaky suite - grok')).toBe(false)
    expect(isGrokRotatingWorkingTitle('⠋ review grok integration - claude')).toBe(false)
  })
})

describe('resolveExplicitTerminalTitleAgentType', () => {
  it('maps explicit product-name titles to their TuiAgent id', () => {
    expect(resolveExplicitTerminalTitleAgentType('✳ Claude Code')).toBe('claude')
    expect(resolveExplicitTerminalTitleAgentType('⠋ Codex')).toBe('codex')
    expect(resolveExplicitTerminalTitleAgentType('✦ Gemini CLI')).toBe('gemini')
    expect(resolveExplicitTerminalTitleAgentType('MiMo Code')).toBe('mimo-code')
    expect(resolveExplicitTerminalTitleAgentType('⠋ OpenClaude')).toBe('openclaude')
    expect(resolveExplicitTerminalTitleAgentType('OMP')).toBe('omp')
  })

  it('treats Claude generic status prefixes as activity-only, not identity', () => {
    expect(resolveExplicitTerminalTitleAgentType('✳ investigating startup')).toBeNull()
    expect(resolveExplicitTerminalTitleAgentType('⠸ investigating startup')).toBeNull()
    expect(resolveExplicitTerminalTitleAgentType('. Compare Opencode Vs Orca')).toBeNull()
    expect(resolveExplicitTerminalTitleAgentType('* Review Codex behavior')).toBeNull()
  })

  it('still resolves Claude when the title explicitly names Claude', () => {
    expect(resolveExplicitTerminalTitleAgentType('. Claude Code compare Opencode')).toBe('claude')
  })

  it('returns null for plain shell and unknown titles', () => {
    expect(resolveExplicitTerminalTitleAgentType('Terminal 1')).toBeNull()
    expect(resolveExplicitTerminalTitleAgentType('zsh')).toBeNull()
  })
})
