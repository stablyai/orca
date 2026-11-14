/**
 * Issue #8940 — opencode displayed as Claude Code.
 *
 * Root cause: getAgentLabel / isClaudeAgent treat Claude-like status prefixes
 * (`. `, `* `, braille spinners) as Claude identity before / instead of
 * requiring an OpenCode name token. OpenCode sessions that emit task titles
 * with those shapes (or without the word "opencode") are labeled Claude Code.
 * Synthetic titles ("OpenCode" / "⠋ OpenCode") briefly flip the tab correct,
 * matching the reported flakiness.
 *
 * Re-run:
 *   pnpm exec vitest run src/shared/repro-8940-opencode-as-claude.test.ts
 */
import { describe, expect, it } from 'vitest'
import { resolveTitleDerivedAgentType } from '../renderer/src/components/sidebar/worktree-title-derived-agent-rows'
import { getAgentLabel, isClaudeAgent } from './agent-detection'
import {
  resolveExplicitTerminalTitleAgentType,
  resolveTerminalTitleAgentType
} from './terminal-title-agent-type'

describe('#8940 OpenCode titles mislabeled as Claude Code', () => {
  it('labels Claude-style task prefixes as Claude even when the task text names OpenCode', () => {
    // Documented intentional Claude prefix win (also in agent-status.test.ts).
    // Problem for OpenCode: if OpenCode (or a wrapper) ever emits ". " / "* "
    // status frames, it is permanently Claude in getAgentLabel.
    expect(getAgentLabel('. Compare Opencode Vs Orca')).toBe('Claude Code')
    expect(getAgentLabel('* Review OpenCode behavior')).toBe('Claude Code')
    expect(resolveTerminalTitleAgentType('. ship it with opencode')).toBe('claude')
  })

  it('treats bare braille + task (no agent name) as Claude activity', () => {
    // OpenCode working frames that lack an "opencode" token fall into the
    // braille → Claude heuristic (isClaudeAgent only excludes cursor/openclaude).
    const openCodeLikeTask = '⠋ implementing the feature'
    expect(isClaudeAgent(openCodeLikeTask)).toBe(true)
    expect(getAgentLabel(openCodeLikeTask)).toBe('Claude Code')
    expect(resolveTerminalTitleAgentType(openCodeLikeTask)).toBe('claude')
  })

  it('does NOT exclude OpenCode the way it excludes OpenClaude from braille Claude claim', () => {
    expect(isClaudeAgent('⠋ OpenClaude')).toBe(false)
    expect(getAgentLabel('⠋ OpenClaude')).toBe('OpenClaude')

    // Correct when the token is present
    expect(getAgentLabel('⠋ OpenCode')).toBe('OpenCode')
    expect(getAgentLabel('OpenCode ready')).toBe('OpenCode')

    // But a spinner title that merely *is* OpenCode's UI without the token
    // is claimed as Claude — isClaudeAgent has no opencode exception.
    expect(isClaudeAgent('⠋ building session resume')).toBe(true)
    expect(getAgentLabel('⠋ building session resume')).toBe('Claude Code')
  })

  it('sidebar title-derived path refuses Claude without a claude token (partial mitigation)', () => {
    // Why: worktree-title-derived-agent-rows requires CLAUDE_AGENT_TOKEN_RE for
    // Claude rows — so pure spinner titles do not mint sidebar Claude rows.
    // Tabs/hover still use getAgentLabel activity facet → "Claude Code".
    expect(resolveTitleDerivedAgentType('⠋ building session resume', 'Claude Code')).toBeNull()
    expect(resolveTitleDerivedAgentType('✳ Claude Code', 'Claude Code')).toBe('claude')
    expect(resolveExplicitTerminalTitleAgentType('⠋ building session resume')).toBeNull()
    expect(resolveExplicitTerminalTitleAgentType('OpenCode ready')).toBe('opencode')
  })

  it('reproduces the flaky tab identity: synthetic OpenCode vs braille task Claude', () => {
    const syntheticWorking = '⠋ OpenCode'
    const nativeTaskWithoutToken = '⠋ fix the auth bug'
    expect(getAgentLabel(syntheticWorking)).toBe('OpenCode')
    expect(getAgentLabel(nativeTaskWithoutToken)).toBe('Claude Code')
    // Alternating OSC / synthetic frames would flip the displayed product name.
  })
})
