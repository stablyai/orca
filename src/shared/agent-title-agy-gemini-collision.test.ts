import { describe, expect, it } from 'vitest'
import { getAgentLabel } from './agent-title-identity'
import { resolveExplicitTerminalTitleAgentType } from './terminal-title-agent-type'
import { GEMINI_IDLE, GEMINI_WORKING } from './agent-title-core'

// agy model names include Gemini; the earlier Gemini token detector once mistook model metadata for pane identity.
describe('agy titles carrying a Gemini model name', () => {
  const AGY_TITLES = [
    '⠋ agy · Gemini 3.7 Flash · high',
    'Antigravity · Gemini 3.7 Flash',
    'agy · Gemini 3.5 Flash (High)'
  ]

  it.each(AGY_TITLES)('labels %s as Antigravity', (title) => {
    expect(getAgentLabel(title)).toBe('Antigravity')
  })

  // Exercise both sidebar and tab detector chains so fixing one cannot leave the surfaces disagreeing.
  it.each(AGY_TITLES)('resolves %s as antigravity on the tab path too', (title) => {
    expect(resolveExplicitTerminalTitleAgentType(title)).toBe('antigravity')
  })
})

describe('titles that must keep their existing label', () => {
  // Recorded Grok task text mentions Antigravity; narrowing the Gemini token avoids changing this ordered-chain result.
  it('keeps a grok pane whose task text names Antigravity', () => {
    expect(getAgentLabel('STA-4011 Linux Antigravity Commit Messages - grok')).toBe('Grok')
  })

  // Why: the four Gemini OSC glyphs are decisive and stay so; agy emits none of them.
  it('still labels a glyph-bearing Gemini CLI title', () => {
    expect(getAgentLabel(`${GEMINI_WORKING} Gemini CLI`)).toBe('Gemini CLI')
    expect(getAgentLabel(`${GEMINI_IDLE} Gemini CLI`)).toBe('Gemini CLI')
  })

  // Why: a Gemini CLI title with no agy token must be unaffected by the narrowing.
  it('still labels a bare gemini token title', () => {
    expect(getAgentLabel('gemini ready')).toBe('Gemini CLI')
  })
})
