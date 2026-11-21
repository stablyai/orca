import { describe, expect, it } from 'vitest'

import { detectAgentStatusFromTitle } from './agent-title-status'
import { getAgentLabel } from './terminal-title-agent-type'

// Gemini CLI computeTerminalTitle (packages/cli/src/utils/windowTitle.ts) pads every frame to 80 columns.
const geminiFrame = (title: string): string => title.padEnd(80, ' ')

describe('Gemini title glyphs', () => {
  it.each([
    [geminiFrame('✋  Action Required (orca)'), 'permission'],
    [`zsh | ${geminiFrame('⏲  Working… (orca)')}`, 'working'],
    [`0:0:node - "${geminiFrame('✦  Compare A | ◇ B (orca)')}"`, 'working'],
    [`Administrator: ${geminiFrame('◇  Ready (✋proj)')}`, 'idle']
  ])('classifies Gemini frame %j', (title, status) => {
    expect(getAgentLabel(title)).toBe('Gemini CLI')
    expect(detectAgentStatusFromTitle(title)).toBe(status)
  })

  it.each(['user@host ✦ ~/orca', 'vim notes✋.md'])(
    'ignores a Gemini glyph inside shell title %j',
    (title) => {
      expect(getAgentLabel(title)).toBeNull()
      expect(detectAgentStatusFromTitle(title)).toBeNull()
    }
  )
})
