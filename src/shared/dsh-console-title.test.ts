import { describe, expect, it } from 'vitest'
import {
  detectAgentStatusFromTitle,
  getAgentLabel,
  normalizeTerminalTitle
} from './agent-detection'
import { collectAgentTitleEvidence } from './agent-title-evidence'
import {
  normalizeCompatibleAgentTitleForOwner,
  resolveCompatibleAgentTypeForOwner
} from './agent-title-owner'

describe('published DSH Console shared title glyphs', () => {
  it.each([
    ['◇  Ready (workspace)', 'DSH Console ready', 'idle'],
    ['✦  Typing prompt... (workspace)', '⠋ DSH Console', 'working'],
    ['⏲  Working… (workspace)', '⠋ DSH Console', 'working'],
    ['✋  Action Required (workspace)', 'DSH Console - action required', 'permission']
  ])('preserves the proven DSH owner for %s', (raw, expected, state) => {
    const title = normalizeCompatibleAgentTitleForOwner(normalizeTerminalTitle(raw), 'dsh-console')
    expect(title).toBe(expected)
    expect(getAgentLabel(title)).toBe('DSH Console')
    expect(collectAgentTitleEvidence(title).agent).toBe('dsh-console')
    expect(detectAgentStatusFromTitle(title)).toBe(state)
  })
  it('keeps other owners and plain shell titles unchanged', () => {
    expect(normalizeCompatibleAgentTitleForOwner('◇ Gemini CLI', 'gemini')).toBe('◇ Gemini CLI')
    expect(normalizeCompatibleAgentTitleForOwner('zsh', 'dsh-console')).toBe('zsh')
    expect(resolveCompatibleAgentTypeForOwner('gemini', 'dsh-console')).toBe('dsh-console')
    expect(resolveCompatibleAgentTypeForOwner('claude', 'dsh-console')).toBe('claude')
  })
  it('recognizes the static branded title without guessing from arbitrary task text', () => {
    expect(collectAgentTitleEvidence('DSH Console (workspace)').agent).toBe('dsh-console')
    expect(collectAgentTitleEvidence('review DSH Console integration').agent).toBeNull()
  })
})
