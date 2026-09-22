import { describe, expect, it } from 'vitest'
import { shouldAutoCreateInitialTerminal } from './initial-terminal'

describe('shouldAutoCreateInitialTerminal', () => {
  it('creates a terminal when the tab-group model has no renderable tabs', () => {
    expect(shouldAutoCreateInitialTerminal(0)).toBe(true)
  })

  it('preserves an explicitly persisted empty terminal list', () => {
    expect(shouldAutoCreateInitialTerminal(0, true)).toBe(false)
  })

  it('does not create a terminal when the tab-group model already has content', () => {
    expect(shouldAutoCreateInitialTerminal(1)).toBe(false)
    expect(shouldAutoCreateInitialTerminal(2)).toBe(false)
  })
})
