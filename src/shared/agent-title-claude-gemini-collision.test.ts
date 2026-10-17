import { describe, expect, it } from 'vitest'
import { isGeminiTerminalTitle } from './agent-title-core'
import { getAgentLabel } from './agent-title-identity'
import { detectAgentStatusFromTitle, normalizeTerminalTitle } from './agent-title-status'
import { resolveCanonicalPaneAgentIdentity } from './pane-agent-identity-adapter'
import {
  getAgentLabel as getTabAgentLabel,
  resolveExplicitTerminalTitleAgentType
} from './terminal-title-agent-type'

describe('Claude task titles mentioning Gemini', () => {
  // The spinner shapes come from the captured Claude turns in repro-13889.
  it.each(['\u25d0', '\u25d1', '\u25d2', '\u25d3', '\u2802', '\u2810', '.'])(
    'preserves the task and activity for frame %s',
    (frame) => {
      const title = `${frame} Alternativas ao Gemini Live`
      expect(normalizeTerminalTitle(title)).toBe(title)
      expect(isGeminiTerminalTitle(title)).toBe(false)
      expect(getAgentLabel(title)).toBe('Claude Code')
      expect(getTabAgentLabel(title)).toBe('Claude Code')
      expect(resolveExplicitTerminalTitleAgentType(title)).toBeNull()
      expect(detectAgentStatusFromTitle(title)).toBe('working')
      expect(
        resolveCanonicalPaneAgentIdentity({
          title: normalizeTerminalTitle(title),
          launchAgent: 'claude'
        }).agent
      ).toBe('claude')
    }
  )

  it.each(['\u2733', '*'])('preserves the idle task with prefix %s', (frame) => {
    const title = `${frame} Alternativas ao Gemini Live`
    expect(normalizeTerminalTitle(title)).toBe(title)
    expect(getAgentLabel(title)).toBe('Claude Code')
    expect(getTabAgentLabel(title)).toBe('Claude Code')
    expect(detectAgentStatusFromTitle(title)).toBe('idle')
  })

  it.each([
    '\u2726 Gemini CLI',
    '\u25c7 Gemini CLI',
    '\u270b Gemini CLI',
    '\u23f2 Gemini CLI',
    'gemini ready',
    '\u280b Gemini CLI'
  ])('keeps genuine Gemini identity for %s', (title) => {
    expect(isGeminiTerminalTitle(title)).toBe(true)
    expect(getAgentLabel(normalizeTerminalTitle(title))).toBe('Gemini CLI')
    expect(resolveExplicitTerminalTitleAgentType(title)).toBe('gemini')
  })
})
