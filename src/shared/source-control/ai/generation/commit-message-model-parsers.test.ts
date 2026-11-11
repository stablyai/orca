import { describe, expect, it } from 'vitest'
import { parseCursorModels } from './commit-message-model-parsers'

describe('parseCursorModels', () => {
  it('reads named and bare cursor-agent rows, including a shared current and default marker', () => {
    const stdout = [
      'Available models',
      '',
      'auto - Auto (current, default)',
      'gpt-5.3-codex-low - Codex 5.3 Low',
      'composer-2',
      'claude-opus-4-8-thinking-high - Claude Opus 4.8 Thinking High (current)',
      '',
      'Tip: use --model <id> (or /model <id> in interactive mode) to switch.'
    ].join('\n')

    expect(
      parseCursorModels(stdout).map(({ id, label, isDefault }) => ({ id, label, isDefault }))
    ).toEqual([
      { id: 'auto', label: 'Auto', isDefault: true },
      { id: 'gpt-5.3-codex-low', label: 'Codex 5.3 Low', isDefault: undefined },
      { id: 'composer-2', label: 'composer-2', isDefault: undefined },
      {
        id: 'claude-opus-4-8-thinking-high',
        label: 'Claude Opus 4.8 Thinking High',
        isDefault: undefined
      }
    ])
  })
})
