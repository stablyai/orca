import { describe, expect, it } from 'vitest'
import { readCodexSessionOptionsFromTerminalScreen } from './codex-terminal-session-options'

const STATUS_LINE = 'gpt-5.6-luna max fast · ████████░░░░'

describe('readCodexSessionOptionsFromTerminalScreen', () => {
  it('reads model and effort from the model-with-reasoning status line', () => {
    expect(readCodexSessionOptionsFromTerminalScreen(STATUS_LINE)).toEqual({
      model: 'gpt-5.6-luna',
      effort: 'max'
    })
  })

  it('ignores a ChatGPT fast service-tier suffix', () => {
    expect(
      readCodexSessionOptionsFromTerminalScreen('gpt-5.6-terra ultra fast · Context 12% used')
    ).toEqual({ model: 'gpt-5.6-terra', effort: 'ultra' })
  })

  it('matches a catalog label the same as its id', () => {
    expect(readCodexSessionOptionsFromTerminalScreen('GPT-5.6 Luna max · /repo')).toEqual({
      model: 'gpt-5.6-luna',
      effort: 'max'
    })
  })

  it('does not treat conversation text that names a model as the status line', () => {
    expect(
      readCodexSessionOptionsFromTerminalScreen(
        'please switch off gpt-5.6-luna max and use terra instead\nready'
      )
    ).toBeNull()
  })

  it('prefers the bottom status line over an earlier mention', () => {
    const screen = [
      'User asked for gpt-5.6-terra ultra',
      '> Find and fix a bug in @filename',
      'gpt-5.6-luna max fast · ████████░░░░'
    ].join('\n')
    expect(readCodexSessionOptionsFromTerminalScreen(screen)).toEqual({
      model: 'gpt-5.6-luna',
      effort: 'max'
    })
  })
})
