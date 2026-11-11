import { describe, expect, it } from 'vitest'
import { getAgentLabel } from './agent-title-identity'
import { normalizeTerminalTitle } from './agent-title-status'
import {
  getAgentLabel as getTabAgentLabel,
  resolveExplicitTerminalTitleAgentType
} from './terminal-title-agent-type'

describe('Claude task titles mentioning Gemini', () => {
  it.each([
    '◐ Alternativas ao Gemini Live',
    '⠂ Alternativas ao Gemini Live',
    '. Alternativas ao Gemini Live',
    '◐ Gemini Live integration',
    '. Gemini rate limits',
    'tmux | ◐ Alternativas ao Gemini Live'
  ])('keeps Claude task %s', (title) => {
    expect(normalizeTerminalTitle(title)).toBe(title)
    expect(getAgentLabel(title)).toBe('Claude Code')
    expect(getTabAgentLabel(title)).toBe('Claude Code')
  })

  it.each([
    '✦ Gemini CLI',
    '⏲ Working… (orca)',
    'gemini ready',
    '⠋ Gemini CLI',
    'zsh | ⠋ Gemini CLI'
  ])('keeps genuine Gemini identity for %s', (title) => {
    expect(getAgentLabel(normalizeTerminalTitle(title))).toBe('Gemini CLI')
    expect(resolveExplicitTerminalTitleAgentType(title)).toBe('gemini')
  })
})
