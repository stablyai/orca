import { describe, expect, it } from 'vitest'
import { getAgentLabel } from './agent-title-identity'
import { resolveExplicitTerminalTitleAgentType } from './terminal-title-agent-type'
import { GEMINI_IDLE, GEMINI_WORKING } from './agent-title-core'

// Why: Antigravity's models are named "Gemini <n.n> <Name>" (see the real `agy models`
// output parsed in commit-message-agent-spec.test.ts), so an agy pane's own title carries a
// whole `gemini` token. Gemini CLI is checked before Antigravity in getAgentLabel, so the
// model name used to win and an agy pane read as Gemini CLI.
describe('agy titles carrying a Gemini model name', () => {
  const AGY_TITLES = [
    '⠋ agy · Gemini 3.7 Flash · high',
    'Antigravity · Gemini 3.7 Flash',
    'agy · Gemini 3.5 Flash (High)'
  ]

  it.each(AGY_TITLES)('labels %s as Antigravity', (title) => {
    expect(getAgentLabel(title)).toBe('Antigravity')
  })

  // Why: the two chain copies are reached by different surfaces — the sidebar goes through
  // getAgentLabel, the tab through resolveExplicitTerminalTitleAgentType. A fix in one only
  // moves the disagreement rather than removing it.
  it.each(AGY_TITLES)('resolves %s as antigravity on the tab path too', (title) => {
    expect(resolveExplicitTerminalTitleAgentType(title)).toBe('antigravity')
  })
})

describe('titles that must keep their existing label', () => {
  // Why: a real recorded pane title from terminal history. A Grok pane whose TASK TEXT
  // contains the token "Antigravity" — it resolves correctly only because grok is checked
  // before antigravity, which is why this fix narrows a token instead of reordering.
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
