/**
 * Issue #8478 — OpenCode logo / icon not coming up well (Claude glyph on
 * OpenCode tabs).
 *
 * Root cause (pre-fix): OpenCode's native OSC tab title format is `OC | <task>`.
 * Title classifiers only recognized OpenCode when the token "opencode" appeared.
 * Native `OC | …` titles fell through, so AgentIcon rendered Claude/"?".
 *
 * OpenCode source (packages/tui/src/app.tsx) sets titles as:
 *   - "OpenCode" on home / default session titles
 *   - `OC | ${title}` for named sessions (title truncated at 40 chars)
 *   - `OC | ${pluginId}` on plugin routes
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

  // Why: bare "OpenCode" is what the TUI sets on home/default sessions; keep it
  // classified so the icon path stays OpenCode without the OC | abbreviation.
  it('keeps bare OpenCode home titles and Claude-style frames classified correctly', () => {
    expect(getAgentLabel('OpenCode')).toBe('OpenCode')
    expect(resolveTerminalTitleAgentType('OpenCode')).toBe('opencode')
    expect(getAgentLabel('OpenCode ready')).toBe('OpenCode')
    expect(resolveTerminalTitleAgentType('OpenCode ready')).toBe('opencode')
    // Same family as #8940: braille/task frames without "opencode" still become Claude
    // when they lack the native OC marker — documented, out of scope for this fix.
    expect(isClaudeAgent('⠋ implementing the feature')).toBe(true)
    expect(getAgentLabel('⠋ implementing the feature')).toBe('Claude Code')
  })
})
