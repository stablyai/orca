import { describe, expect, it } from 'vitest'
import { hasFlag } from './agent-cli-flag-detection'

const MODEL_FLAGS = ['-m', '--model']

describe('hasFlag', () => {
  it('matches an exact token', () => {
    expect(hasFlag(['-m', 'grok-build'], MODEL_FLAGS)).toBe(true)
    expect(hasFlag(['--model', 'grok-build'], MODEL_FLAGS)).toBe(true)
  })

  it('matches the flag=value form', () => {
    expect(hasFlag(['--model=grok-build'], MODEL_FLAGS)).toBe(true)
    expect(hasFlag(['-m=grok-build'], MODEL_FLAGS)).toBe(true)
  })

  it('matches a clustered single-dash flag', () => {
    expect(hasFlag(['-mgrok-build'], MODEL_FLAGS)).toBe(true)
  })

  it('does not clusters-match a long flag that merely shares the prefix', () => {
    // `--model-context` is its own option; treating it as `--model` would silently
    // discard the picker's model from the launch record.
    expect(hasFlag(['--model-context', '8000'], MODEL_FLAGS)).toBe(false)
    expect(hasFlag(['--models'], MODEL_FLAGS)).toBe(false)
  })

  it('ignores positional args that merely contain a flag substring', () => {
    expect(hasFlag(['summarize-my-diff'], MODEL_FLAGS)).toBe(false)
    expect(hasFlag(['fix -m please'], MODEL_FLAGS)).toBe(false)
    expect(hasFlag(['/tmp/-m'], MODEL_FLAGS)).toBe(false)
  })

  it('is false for empty token lists and unrelated flags', () => {
    expect(hasFlag([], MODEL_FLAGS)).toBe(false)
    expect(hasFlag(['--reasoning-effort', 'low'], MODEL_FLAGS)).toBe(false)
  })

  it('scans every token, not just the first', () => {
    expect(hasFlag(['--debug', '--yolo', '--model', 'grok-build'], MODEL_FLAGS)).toBe(true)
  })

  it('stops scanning at the option terminator', () => {
    expect(hasFlag(['--', '--model'], MODEL_FLAGS)).toBe(false)
    expect(hasFlag(['--', '-mgrok-build'], MODEL_FLAGS)).toBe(false)
    expect(hasFlag(['--model', 'grok-build', '--', '--model'], MODEL_FLAGS)).toBe(true)
  })

  it('detects either spelling of grok effort flags', () => {
    const effortFlags = ['--effort', '--reasoning-effort']
    expect(hasFlag(['--effort', 'low'], effortFlags)).toBe(true)
    expect(hasFlag(['--reasoning-effort=low'], effortFlags)).toBe(true)
    expect(hasFlag(['--effortless'], effortFlags)).toBe(false)
  })
})
