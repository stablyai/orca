import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _setZotzAllTuiAgentsVisibleForTests, applyZotzVisibleAgents } from './zotz-visible-agents'

describe('applyZotzVisibleAgents', () => {
  beforeEach(() => _setZotzAllTuiAgentsVisibleForTests(false))
  afterEach(() => _setZotzAllTuiAgentsVisibleForTests(true))

  it('hides every agent except claude, codex and antigravity on a fresh profile', () => {
    const { disabledTuiAgents } = applyZotzVisibleAgents([], undefined)
    expect(disabledTuiAgents).toContain('gemini')
    expect(disabledTuiAgents).toContain('opencode')
    expect(disabledTuiAgents).not.toContain('claude')
    expect(disabledTuiAgents).not.toContain('codex')
    expect(disabledTuiAgents).not.toContain('antigravity')
  })

  it('keeps agents the user re-enabled and hides only ones it has not seen', () => {
    const { zotzSeenTuiAgents = [] } = applyZotzVisibleAgents([], undefined)
    const seenBeforeSync = zotzSeenTuiAgents.filter((agent) => agent !== 'aider')
    const { disabledTuiAgents } = applyZotzVisibleAgents(['claude'], seenBeforeSync)
    expect(disabledTuiAgents).toEqual(['claude', 'aider'])
  })
})
