import { describe, expect, it } from 'vitest'
import { readMuseSessionOptionsFromTerminalScreen } from './muse-terminal-session-options'

// Captured from a live `muse` 1.4.10 TUI: model, effort, cwd, mode.
const STATUS_LINE = '  muse-spark-1.3 · max · /tmp/muse-tui · YOLO'

describe('readMuseSessionOptionsFromTerminalScreen', () => {
  it('reads model and effort from the status line', () => {
    expect(readMuseSessionOptionsFromTerminalScreen(`Muse Code 1.4.10\n❯\n${STATUS_LINE}`)).toEqual(
      { model: 'muse-spark-1.3', effort: 'max' }
    )
  })

  it('reports every reasoning-effort id including none', () => {
    for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
      expect(readMuseSessionOptionsFromTerminalScreen(`m · ${effort} · ~/repo · YOLO`)).toEqual({
        model: 'm',
        effort
      })
    }
  })

  it('scans bottom-up past user text sharing the shape', () => {
    const screen = [
      'muse-spark-1.3 · max · ~/repo · YOLO',
      'some user text',
      'other-model · low · ~/other · YOLO'
    ].join('\n')
    expect(readMuseSessionOptionsFromTerminalScreen(screen)).toEqual({
      model: 'other-model',
      effort: 'low'
    })
  })

  it('strips ANSI before matching', () => {
    const screen = `\u001b[36m${STATUS_LINE}\u001b[0m`
    expect(readMuseSessionOptionsFromTerminalScreen(screen)).toEqual({
      model: 'muse-spark-1.3',
      effort: 'max'
    })
  })

  it('matches the spaceless xterm-serialized form', () => {
    // Why: terminal serialization drops the padding around the separators.
    expect(
      readMuseSessionOptionsFromTerminalScreen('muse-spark-1.3·low·/tmp/muse-live/wt·YOLO')
    ).toEqual({ model: 'muse-spark-1.3', effort: 'low' })
  })

  it('accepts a multi-word mode slot', () => {
    expect(
      readMuseSessionOptionsFromTerminalScreen(
        'muse-spark-1.3 · low · /tmp/muse-live/wt · Launch overrides'
      )
    ).toEqual({ model: 'muse-spark-1.3', effort: 'low' })
  })

  it('returns null without a status line', () => {
    expect(readMuseSessionOptionsFromTerminalScreen(null)).toBeNull()
    expect(readMuseSessionOptionsFromTerminalScreen(undefined)).toBeNull()
    expect(readMuseSessionOptionsFromTerminalScreen('')).toBeNull()
    expect(readMuseSessionOptionsFromTerminalScreen('❯ just a composer')).toBeNull()
    // Unknown effort ids never match a picker choice, so they report nothing.
    expect(readMuseSessionOptionsFromTerminalScreen('m · warp9 · ~/repo · YOLO')).toBeNull()
  })
})
