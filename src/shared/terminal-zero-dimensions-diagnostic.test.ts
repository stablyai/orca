import { describe, expect, it } from 'vitest'
import { createTerminalZeroDimensionsMessage } from './terminal-zero-dimensions-diagnostic'

describe('terminal zero-dimensions diagnostic', () => {
  it('produces a stable human-readable message', () => {
    expect(createTerminalZeroDimensionsMessage(0, 0)).toBe(
      'Terminal has zero dimensions (0×0). The pane container may not be visible.'
    )
  })
})
