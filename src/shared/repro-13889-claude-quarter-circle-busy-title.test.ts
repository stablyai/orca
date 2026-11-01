import { describe, expect, it } from 'vitest'

import {
  clearWorkingIndicators,
  createAgentStatusTracker,
  detectAgentStatusFromTitle,
  getAgentLabel,
  isClaudeAgent
} from './agent-detection'
import { isDecorativeAgentTitleFrameChange } from './agent-decorative-title-signature'
import { stripLeadingAgentTitleDecoration } from './agent-title-decoration'

// Titles captured from real `claude` binaries running the same one-line prompt.
// 2.1.228 swapped the busy spinner from braille to quarter circles, which read as
// "no agent" and made the tracker report a confirmed exit mid-turn (#13889).
const BUSY_2_1_228 = ['◐ Claude Code', '◑ Claude Code', '◑ Say hi in one word'] as const

const CAPTURED_2_1_228_TURN = [
  '✳ Claude Code',
  '◐ Claude Code',
  '◑ Claude Code',
  '◑ Say hi in one word',
  '◐ Say hi in one word',
  '✳ Say hi in one word'
] as const

function trackTurn(titles: readonly string[]): string[] {
  const events: string[] = []
  const tracker = createAgentStatusTracker(
    () => events.push('idle'),
    () => events.push('working'),
    () => events.push('exited')
  )
  for (const title of titles) {
    tracker.handleTitle(title)
  }
  return events
}

describe('Claude Code quarter-circle busy titles (#13889)', () => {
  it('reports working for every quarter-circle spinner frame', () => {
    for (const title of ['◐ Claude Code', '◑ Claude Code', '◒ Claude Code', '◓ Claude Code']) {
      expect(detectAgentStatusFromTitle(title)).toBe('working')
    }
  })

  it('reports working when the busy title carries task text instead of the agent name', () => {
    // Task-only busy frames previously fell through to null, which the tracker treats as exit.
    expect(detectAgentStatusFromTitle('◐ Say hi in one word')).toBe('working')
  })

  it('keeps Claude identity while busy', () => {
    for (const title of BUSY_2_1_228) {
      expect(isClaudeAgent(title)).toBe(true)
      expect(getAgentLabel(title)).toBe('Claude Code')
    }
  })

  it('never confirms an agent exit across a real 2.1.228 turn', () => {
    const events = trackTurn(CAPTURED_2_1_228_TURN)
    expect(events).not.toContain('exited')
    expect(events).toEqual(['working', 'idle'])
  })

  it('strips the spinner from stale exit titles and displayed labels', () => {
    expect(clearWorkingIndicators('◐ Say hi in one word')).toBe('Say hi in one word')
    expect(stripLeadingAgentTitleDecoration('◐ Claude Code')).toBe('Claude Code')
  })

  it('treats a spinner tick as decoration, not a title change', () => {
    expect(isDecorativeAgentTitleFrameChange('◐ Say hi', '◑ Say hi')).toBe(true)
  })

  it('does not claim Gemini’s ◇ idle glyph, which neighbors the spinner block', () => {
    expect(detectAgentStatusFromTitle('◇ Gemini CLI')).toBe('idle')
    expect(getAgentLabel('◇ Gemini CLI')).toBe('Gemini CLI')
  })
})
