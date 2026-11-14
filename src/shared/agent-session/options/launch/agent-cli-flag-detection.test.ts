import { describe, expect, it } from 'vitest'
import { hasFlag } from './agent-cli-flag-detection'

const MODEL_FLAGS = ['-m', '--model']

describe('hasFlag', () => {
  it('does not clusters-match a long flag that merely shares the prefix', () => {
    // --model-context is a separate option; prefix matching would discard the picker's model.
    expect(hasFlag(['--model-context', '8000'], MODEL_FLAGS)).toBe(false)
    expect(hasFlag(['--models'], MODEL_FLAGS)).toBe(false)
  })

  it('ignores positional args that merely contain a flag substring', () => {
    expect(hasFlag(['summarize-my-diff'], MODEL_FLAGS)).toBe(false)
    expect(hasFlag(['fix -m please'], MODEL_FLAGS)).toBe(false)
    expect(hasFlag(['/tmp/-m'], MODEL_FLAGS)).toBe(false)
  })

  it('stops scanning at the option terminator', () => {
    expect(hasFlag(['--', '--model'], MODEL_FLAGS)).toBe(false)
    expect(hasFlag(['--', '-mgrok-build'], MODEL_FLAGS)).toBe(false)
    expect(hasFlag(['--model', 'grok-build', '--', '--model'], MODEL_FLAGS)).toBe(true)
  })
})
