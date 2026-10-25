import { describe, expect, it } from 'vitest'
import { detectAgentStatusFromTitle, normalizeTerminalTitle } from './agent-title-status'
import { isDshTerminalTitle, isGeminiTerminalTitle } from './agent-title-core'
import { getAgentLabel, resolveExplicitTerminalTitleAgentType } from './terminal-title-agent-type'

// DSH’s idle ✦ and working braille collide with Gemini/Claude; whale identity must win. Capture: src/main/runtime/__fixtures__/dsh-tui-ready-no-key.txt.
const RESTING = '✦ \u{1F40B} dsh-demo-repo'
const WORKING_FRAMES = ['⠂ \u{1F40B} fix the flaky test', '⠐ \u{1F40B} fix the flaky test']

describe('a DSH-TUI terminal title', () => {
  it('is recognized by its whale', () => {
    expect(isDshTerminalTitle(RESTING)).toBe(true)
    expect(isDshTerminalTitle('✦ some other agent')).toBe(false)
  })

  it('is never read as Gemini CLI', () => {
    expect(isGeminiTerminalTitle(RESTING)).toBe(false)
    expect(getAgentLabel(RESTING)).toBe('DeepSeek Harness')
    expect(resolveExplicitTerminalTitleAgentType(RESTING)).toBe('dsh')
  })

  it('survives normalization instead of being rewritten to Gemini', () => {
    expect(normalizeTerminalTitle(RESTING)).toBe(RESTING)
  })

  it('does not report working just because it carries Gemini’s working glyph', () => {
    // DSH idle ✦ must not inherit Gemini’s working state.
    expect(detectAgentStatusFromTitle(RESTING)).toBeNull()
  })

  it('keeps its working frames out of Claude’s braille lane', () => {
    for (const frame of WORKING_FRAMES) {
      expect(getAgentLabel(frame)).toBe('DeepSeek Harness')
    }
  })

  it('leaves a real Gemini title alone', () => {
    expect(isGeminiTerminalTitle('✦ gemini')).toBe(true)
    expect(normalizeTerminalTitle('✦ gemini')).toBe('✦ Gemini CLI')
  })
})
