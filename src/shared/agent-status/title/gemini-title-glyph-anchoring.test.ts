import { describe, expect, it } from 'vitest'

import { detectAgentStatusFromTitle } from './agent-title-status'
import { getAgentLabel } from './terminal-title-agent-type'

// Gemini CLI computeTerminalTitle (packages/cli/src/utils/windowTitle.ts) pads every frame to 80 columns.
const geminiFrame = (title: string): string => title.padEnd(80, ' ')

const GEMINI_FRAMES = [
  [geminiFrame('✋  Action Required (orca)'), 'permission'],
  [geminiFrame('⏲  Working… (orca)'), 'working'],
  [geminiFrame('✦  Refactor the parser (orca)'), 'working'],
  [geminiFrame('◇  Ready (orca)'), 'idle'],
  // A later glyph in the thought or cwd text must not override the leading one.
  [geminiFrame('✦  Compare A | ◇ B (orca)'), 'working'],
  [geminiFrame('◇  Ready (✋proj)'), 'idle']
] as const

describe('Gemini title glyphs', () => {
  it.each(GEMINI_FRAMES)(
    'classifies Gemini frame %j directly and behind wrappers',
    (frame, status) => {
      // tmux set-titles default format and Windows elevated consoles prefix the title without ` | `.
      for (const title of [
        frame,
        `zsh | ${frame}`,
        `0:0:node - "${frame}"`,
        `Administrator: ${frame}`
      ]) {
        expect(getAgentLabel(title)).toBe('Gemini CLI')
        expect(detectAgentStatusFromTitle(title)).toBe(status)
      }
    }
  )

  it.each(['user@host ✦ ~/orca', 'user@host:~/orca ◇', 'vim notes✋.md', 'tail -f build⏲.log'])(
    'ignores a Gemini glyph inside shell title %j',
    (title) => {
      expect(getAgentLabel(title)).toBeNull()
      expect(detectAgentStatusFromTitle(title)).toBeNull()
    }
  )
})
