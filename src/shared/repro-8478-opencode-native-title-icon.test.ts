/** OpenCode’s native OC | task/plugin titles lack “opencode” and previously selected Claude/? icons (#8478).
 * Bare OpenCode remains the home/default title; tokenless braille frames are a separate case (#8940). */
import { describe, expect, it } from 'vitest'
import { getAgentLabel, isClaudeAgent } from './agent-detection'
import {
  resolveExplicitTerminalTitleAgentType,
  resolveTerminalTitleAgentType
} from './terminal-title-agent-type'

describe('#8478 OpenCode native OC | titles map to OpenCode icon', () => {
  it('recognizes OpenCode native "OC | …" title format as opencode identity', () => {
    const native = 'OC | Understand about the plugin'
    expect(getAgentLabel(native)).toBe('OpenCode')
    expect(resolveTerminalTitleAgentType(native)).toBe('opencode')
    expect(resolveExplicitTerminalTitleAgentType(native)).toBe('opencode')
    expect(isClaudeAgent(native)).toBe(false)
  })

  it('keeps bare OpenCode home titles and Claude-style frames classified correctly', () => {
    expect(getAgentLabel('OpenCode')).toBe('OpenCode')
    expect(resolveTerminalTitleAgentType('OpenCode')).toBe('opencode')
    expect(getAgentLabel('OpenCode ready')).toBe('OpenCode')
    expect(resolveTerminalTitleAgentType('OpenCode ready')).toBe('opencode')
    // Tokenless braille frames still select Claude (#8940); separate from native OC markers.
    expect(isClaudeAgent('⠋ implementing the feature')).toBe(true)
    expect(getAgentLabel('⠋ implementing the feature')).toBe('Claude Code')
  })
})
