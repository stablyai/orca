import { describe, expect, it } from 'vitest'
import type { CommitMessageModelCapability } from '../../../../shared/commit-message-agent-spec'
import { buildCodexModelPickerStages } from './native-chat-codex-model-picker'

const models: CommitMessageModelCapability[] = [
  {
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6-Sol',
    thinkingLevels: [
      { id: 'low', label: 'Low' },
      { id: 'high', label: 'High' },
      { id: 'ultra', label: 'Ultra' }
    ],
    defaultThinkingLevel: 'low'
  },
  {
    id: 'gpt-5.6-terra',
    label: 'GPT-5.6-Terra',
    thinkingLevels: [
      { id: 'low', label: 'Low' },
      { id: 'medium', label: 'Medium' }
    ],
    defaultThinkingLevel: 'medium'
  }
]

describe('buildCodexModelPickerStages', () => {
  it('selects a model and its reasoning effort in separate popup stages', () => {
    expect(buildCodexModelPickerStages(models, 'gpt-5.6-terra', 'medium')).toEqual([
      '\x1b[H\x1b[B\r',
      '\x1b[H\x1b[B\r'
    ])
  })

  it('opens All models first when visible auto presets exist', () => {
    expect(
      buildCodexModelPickerStages(
        [{ id: 'codex-auto-fast', label: 'Fast', defaultThinkingLevel: 'low' }, ...models],
        'gpt-5.6-sol',
        'high'
      )
    ).toEqual(['\x1b[F\r', '\x1b[H\r', '\x1b[H\x1b[B\r'])
  })

  it('applies an auto preset directly', () => {
    expect(
      buildCodexModelPickerStages(
        [
          { id: 'codex-auto-fast', label: 'Fast' },
          { id: 'codex-auto-balanced', label: 'Balanced' },
          ...models
        ],
        'codex-auto-balanced',
        null
      )
    ).toEqual(['\x1b[H\x1b[B\r'])
  })

  it('rejects unknown model and effort ids', () => {
    expect(buildCodexModelPickerStages(models, 'missing', 'low')).toBeNull()
    expect(buildCodexModelPickerStages(models, 'gpt-5.6-sol', 'missing')).toBeNull()
  })
})
