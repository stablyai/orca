import { isGeminiTerminalTitle as isCoreGeminiTitle } from './agent-title-core'
import { detectAgentStatusFromTitle, normalizeTerminalTitle } from './agent-title-status'
import { describe, expect, it } from 'vitest'
import { isClaudeAgent as isIdentityClaudeAgent, getAgentLabel } from './agent-title-identity'
import { isDeepSeekBuildTerminalTitle } from './dsb-terminal-title'
import {
  getAgentLabel as getTerminalTitleAgentLabel,
  isClaudeAgent,
  resolveTerminalTitleAgentType
} from './terminal-title-agent-type'
import { collectAgentTitleEvidence } from './agent-title-evidence'
import { resolveCanonicalPaneAgentIdentity } from './pane-agent-identity-adapter'

const WORKING = '⠼ - Waiting for response… - DeepSeek Build'
const CLAUDE_MENTION = '⠋ Review DeepSeek Build integration'

describe('DeepSeek Build terminal titles', () => {
  it.each(['⠂', '⠐', '✦'])('keeps a native DSH %s title from becoming DSB', (prefix) => {
    const title = `${prefix} 🐋 Review integration - DeepSeek Build`
    expect(isDeepSeekBuildTerminalTitle(title)).toBe(false)
    expect(resolveTerminalTitleAgentType(title)).toBe('dsh')
    expect(collectAgentTitleEvidence(title).anchoredNames).not.toContain('dsb')
  })

  it.each(['Codex', 'Gemini', 'Claude', 'OpenCode', 'Grok', 'Cursor', 'Pi', 'Hermes'])(
    'keeps the DeepSeek Build owner when task text mentions %s',
    (agent) => {
      const title = `⠋ - Review ${agent} integration - DeepSeek Build`
      expect(resolveTerminalTitleAgentType(title)).toBe('dsb')
      expect(getAgentLabel(title)).toBe('DeepSeek Build')
      expect(collectAgentTitleEvidence(title).agent).toBe('dsb')
      expect(resolveCanonicalPaneAgentIdentity({ title }).agent).toBe('dsb')
      expect(isClaudeAgent(title)).toBe(false)
      expect(isIdentityClaudeAgent(title)).toBe(false)
    }
  )

  it.each([
    ['✳ Review Codex - DeepSeek Build', 'claude', 'Claude Code'],
    ['. Review Codex - DeepSeek Build', 'claude', 'Claude Code'],
    ['* Review Codex - DeepSeek Build', 'claude', 'Claude Code'],
    ['✦ Review Codex - DeepSeek Build', 'gemini', 'Gemini CLI']
  ])('preserves explicit vendor markers in %s', (title, agent, label) => {
    expect(resolveTerminalTitleAgentType(title)).toBe(agent)
    expect(getAgentLabel(title)).toBe(label)
  })

  it.each([
    '⠋ Review Codex integration - DeepSeek Build',
    '⠋ Review integration - DeepSeek Build',
    '◐ Review integration - DeepSeek Build'
  ])('does not turn a Claude task suffix into DSB identity: %s', (title) => {
    expect(isDeepSeekBuildTerminalTitle(title)).toBe(false)
    expect(isClaudeAgent(title)).toBe(true)
    expect(isIdentityClaudeAgent(title)).toBe(true)
    expect(collectAgentTitleEvidence(title).anchoredNames).not.toContain('dsb')
    expect(resolveCanonicalPaneAgentIdentity({ title }).agent).not.toBe('dsb')
  })

  it.each(['✦', '⏲', '◇', '✋'])('keeps task glyph %s from changing a DSB owner', (glyph) => {
    const busy = `⠋ - Review ${glyph} rendering - DeepSeek Build`
    for (const title of [busy, `zsh | ${busy}`, `⚠ Action Required - ${busy}`]) {
      expect(isCoreGeminiTitle(title)).toBe(false)
      expect(normalizeTerminalTitle(title)).toBe(title)
      expect(detectAgentStatusFromTitle(title)).toBe(
        title.startsWith('⚠') ? 'permission' : 'working'
      )
      expect(resolveTerminalTitleAgentType(title)).toBe('dsb')
      expect(getAgentLabel(title)).toBe('DeepSeek Build')
      expect(getTerminalTitleAgentLabel(title)).toBe('DeepSeek Build')
      expect(collectAgentTitleEvidence(title).agent).toBe('dsb')
      expect(resolveCanonicalPaneAgentIdentity({ title }).agent).toBe('dsb')
    }
  })

  it.each(['✦', '⏲', '◇', '✋'])('keeps idle task glyph %s from changing Build status', (glyph) => {
    const title = `Review ${glyph} rendering - DeepSeek Build`
    expect(detectAgentStatusFromTitle(title)).toBe('idle')
    expect(normalizeTerminalTitle(title)).toBe(title)
  })

  it('matches the product segment and not a mention inside another task', () => {
    expect(isDeepSeekBuildTerminalTitle('DeepSeek Build')).toBe(true)
    expect(isDeepSeekBuildTerminalTitle('my-project - DeepSeek Build')).toBe(true)
    expect(isDeepSeekBuildTerminalTitle(WORKING)).toBe(true)
    expect(isDeepSeekBuildTerminalTitle(CLAUDE_MENTION)).toBe(false)
    expect(isDeepSeekBuildTerminalTitle('Warning: DeepSeek Build')).toBe(false)
  })

  it('keeps a Claude task that mentions DeepSeek Build on both title classifiers', () => {
    expect(isClaudeAgent(CLAUDE_MENTION)).toBe(true)
    expect(isIdentityClaudeAgent(CLAUDE_MENTION)).toBe(true)
    expect(resolveTerminalTitleAgentType(CLAUDE_MENTION)).toBe('claude')
    expect(getAgentLabel(CLAUDE_MENTION)).toBe('Claude Code')
    expect(resolveTerminalTitleAgentType(WORKING)).toBe('dsb')
    expect(getAgentLabel(WORKING)).toBe('DeepSeek Build')
    expect(isClaudeAgent(WORKING)).toBe(false)
    expect(isIdentityClaudeAgent(WORKING)).toBe(false)
  })
})
