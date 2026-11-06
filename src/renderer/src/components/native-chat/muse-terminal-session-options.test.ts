import { describe, expect, it } from 'vitest'
import { readMuseSessionOptionsFromTerminalScreen } from './muse-terminal-session-options'

// Captured from Muse Code 1.4.14 after `/effort ultra` fell back to xhigh.
const SCREEN = [
  '  Muse Code 1.4.14',
  '  reasoning effort ultra is not available (gate ultra_reasoning_effort is closed); using xhigh',
  '── Voice input (alt(option)+v to start) ──────────────────',
  '❯',
  '──────────────────────────────────────────────────────────',
  '  muse-spark-1.3 · xhigh · /private/tmp/muse-scratch · Launch overrides'
].join('\n')

describe('readMuseSessionOptionsFromTerminalScreen', () => {
  it('reads the model and effort from the TUI footer', () => {
    expect(readMuseSessionOptionsFromTerminalScreen(SCREEN)).toEqual({
      model: 'muse-spark-1.3',
      effort: 'xhigh'
    })
  })

  it('prefers the newest footer over one left in scrollback', () => {
    const older = '  muse-spark-1.3 · high · /private/tmp/muse-scratch · Auto-review'
    expect(readMuseSessionOptionsFromTerminalScreen(`${older}\n${SCREEN}`)).toEqual({
      model: 'muse-spark-1.3',
      effort: 'xhigh'
    })
  })
})
