import { describe, expect, it } from 'vitest'
import { buildDefaultTerminalOptions } from './pane-lifecycle'

describe('buildDefaultTerminalOptions', () => {
  it('leaves macOS Option available for keyboard layout characters', () => {
    expect(buildDefaultTerminalOptions().macOptionIsMeta).toBe(false)
  })
})
