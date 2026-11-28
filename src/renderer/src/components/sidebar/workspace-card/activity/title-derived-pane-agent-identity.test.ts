import { describe, expect, it } from 'vitest'
import { resolveTitleDerivedAgentType } from './title-derived-pane-agent-identity'

describe('title-derived Kiro identity', () => {
  it("reads Kiro's synthetic hook titles as the Kiro agent", () => {
    // Why: Kiro sets no OSC title through a turn, so these hook-written titles are the only live
    // identity an idle Kiro pane keeps once its hook row is past the stale window.
    expect(resolveTitleDerivedAgentType('Kiro ready', 'Kiro ready')).toBe('kiro')
    expect(resolveTitleDerivedAgentType('Kiro - action required', 'Kiro - action required')).toBe(
      'kiro'
    )
  })

  it('does not read kiro inside a path or hyphenated name as the agent', () => {
    for (const title of ['kiro-cli', '~/.kiro', 'orca-kiro-hooks']) {
      expect(resolveTitleDerivedAgentType(title, title)).toBeNull()
    }
  })
})
