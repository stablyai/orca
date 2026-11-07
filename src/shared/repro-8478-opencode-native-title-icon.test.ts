/**
 * Issue #8478 — OpenCode logo / icon not coming up well (Claude glyph on
 * OpenCode tabs).
 *
 * Root cause: OpenCode's native OSC tab title format is `OC | <task>`.
 * Current title classifiers only recognize OpenCode when the token
 * "opencode" appears (titleHasAgentName). Native `OC | …` titles therefore
 * fall through to Claude heuristics (braille / generic) or stay unknown,
 * so AgentIcon renders the Claude glyph (or "?").
 *
 * Related: #8940 (OpenCode activity frames mislabeled Claude Code).
 * Fix PR (open): #8590 — recognize OpenCode native `OC | …` titles.
 *
 * Re-run:
 *   pnpm exec vitest run --config config/vitest.config.ts \
 *     src/shared/repro-8478-opencode-native-title-icon.test.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getAgentLabel, isClaudeAgent } from './agent-detection'
import {
  resolveExplicitTerminalTitleAgentType,
  resolveTerminalTitleAgentType
} from './terminal-title-agent-type'
import { agentTypeToIconAgent } from '../renderer/src/lib/agent-status'

const titleClassifierSource = readFileSync(join(__dirname, 'terminal-title-agent-type.ts'), 'utf8')
const titleCoreSource = readFileSync(join(__dirname, 'agent-title-core.ts'), 'utf8')

describe('#8478 OpenCode native OC | titles mis-icon as Claude', () => {
  it('does not recognize OpenCode native "OC | …" title format', () => {
    const native = 'OC | Understand about the plugin'
    // No OC-native matcher in current tree (PR #8590 not landed).
    expect(titleClassifierSource).not.toMatch(/OC\s*\|/)
    expect(titleCoreSource).not.toMatch(/OC\s*\|/)

    expect(getAgentLabel(native)).not.toBe('OpenCode')
    expect(resolveTerminalTitleAgentType(native)).not.toBe('opencode')
    expect(resolveExplicitTerminalTitleAgentType(native)).not.toBe('opencode')
  })

  it('maps unresolved native OpenCode title away from OpenCode icon agent', () => {
    const native = 'OC | Understand about the plugin'
    const agentType = resolveTerminalTitleAgentType(native)
    // Either null or a wrong agent — never opencode today.
    expect(agentType).not.toBe('opencode')
    const iconAgent = agentTypeToIconAgent(agentType)
    expect(iconAgent).not.toBe('opencode')
  })

  it('still labels Claude-style prefixes as Claude (path that steals OpenCode frames)', () => {
    // Same family as #8940: braille/task frames without "opencode" → Claude.
    expect(isClaudeAgent('⠋ implementing the feature')).toBe(true)
    expect(getAgentLabel('⠋ implementing the feature')).toBe('Claude Code')
    // Explicit token still works when present.
    expect(getAgentLabel('OpenCode ready')).toBe('OpenCode')
    expect(resolveTerminalTitleAgentType('OpenCode ready')).toBe('opencode')
  })
})
