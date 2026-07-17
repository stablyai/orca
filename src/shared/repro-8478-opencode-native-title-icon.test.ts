/**
 * Issue #8478 — OpenCode logo / icon not coming up well (Claude glyph on
 * OpenCode tabs).
 *
 * Root cause (pre-fix): OpenCode's native OSC tab title format is `OC | <task>`.
 * Title classifiers only recognized OpenCode when the token "opencode" appeared.
 * Native `OC | …` titles fell through, so AgentIcon rendered Claude/"?".
 *
 * Related: #8940 (OpenCode activity frames mislabeled Claude Code — separate
 * braille-without-token path; not fully solved here).
 *
 * Re-run:
 *   pnpm exec vitest run --config config/vitest.config.ts \
 *     src/shared/repro-8478-opencode-native-title-icon.test.ts
 */
import { describe, expect, it } from 'vitest'
import { getAgentLabel, isClaudeAgent } from './agent-detection'
import { agentTypeToIconAgent } from '../renderer/src/lib/agent-status'
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

  it('maps native OpenCode title to the OpenCode icon agent', () => {
    const native = 'OC | Understand about the plugin'
    const agentType = resolveTerminalTitleAgentType(native)
    expect(agentType).toBe('opencode')
    expect(agentTypeToIconAgent(agentType)).toBe('opencode')
  })

  it('keeps Claude-style prefixes as Claude and explicit OpenCode tokens as OpenCode', () => {
    // Same family as #8940: braille/task frames without "opencode" still become Claude
    // when they lack the native OC marker — documented, out of scope for this fix.
    expect(isClaudeAgent('⠋ implementing the feature')).toBe(true)
    expect(getAgentLabel('⠋ implementing the feature')).toBe('Claude Code')
    expect(getAgentLabel('OpenCode ready')).toBe('OpenCode')
    expect(resolveTerminalTitleAgentType('OpenCode ready')).toBe('opencode')
  })
})
