import { describe, expect, it } from 'vitest'
import { readMuseSessionOptionsFromTerminalScreen } from './muse-terminal-session-options'

// The TUI status line as the terminal serializer hands it over: ANSI-wrapped,
// `<model> · <effort> · <cwd> · <mode>`, sitting at the bottom of the screen.
const SCREEN_WITH_STATUS = [
  '\u001b[38;2;136;136;136m────────────────────────────────────────\u001b[0m',
  '\u001b[0m❯ Try "fix typecheck errors"',
  '\u001b[34mmuse-spark-1.3-contributor\u001b[0m · \u001b[34mmax\u001b[0m · ~/Development/GitHub/orca · \u001b[31mYOLO\u001b[0m'
].join('\n')

describe('readMuseSessionOptionsFromTerminalScreen', () => {
  it('returns null without a screen or a status line', () => {
    expect(readMuseSessionOptionsFromTerminalScreen(null)).toBeNull()
    expect(readMuseSessionOptionsFromTerminalScreen(undefined)).toBeNull()
    expect(readMuseSessionOptionsFromTerminalScreen('')).toBeNull()
    expect(readMuseSessionOptionsFromTerminalScreen('plain output\nno status here')).toBeNull()
  })

  it('reads model and effort from the status line', () => {
    expect(readMuseSessionOptionsFromTerminalScreen(SCREEN_WITH_STATUS)).toEqual({
      model: 'muse-spark-1.3-contributor',
      effort: 'max'
    })
  })

  it('reports effort none even though the picker omits it', () => {
    const screen = 'muse-spark-1.3-contributor · none · ~/repo · YOLO'
    expect(readMuseSessionOptionsFromTerminalScreen(screen)).toEqual({
      model: 'muse-spark-1.3-contributor',
      effort: 'none'
    })
  })

  it('prefers the bottommost status-shaped line', () => {
    const screen = [
      'muse-spark-1.3 · low · ~/old · YOLO',
      'some user text mentioning high effort',
      'muse-spark-1.3 · ultra · ~/repo · YOLO'
    ].join('\n')
    expect(readMuseSessionOptionsFromTerminalScreen(screen)).toEqual({
      model: 'muse-spark-1.3',
      effort: 'ultra'
    })
  })

  it('rejects unknown effort words', () => {
    const screen = 'muse-spark-1.3 · extreme · ~/repo · YOLO'
    expect(readMuseSessionOptionsFromTerminalScreen(screen)).toBeNull()
  })
})
