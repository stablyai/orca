import { describe, expect, it } from 'vitest'
import {
  buildDefaultTerminalOptions,
  resolveTerminalBoldBrightColors
} from './pane-terminal-options'

describe('resolveTerminalBoldBrightColors', () => {
  it('maps true and false through, and treats unset as on', () => {
    expect(resolveTerminalBoldBrightColors(true)).toBe(true)
    expect(resolveTerminalBoldBrightColors(false)).toBe(false)
    expect(resolveTerminalBoldBrightColors(undefined)).toBe(true)
  })

  it('keeps bold-in-bright on in the default xterm options', () => {
    expect(buildDefaultTerminalOptions().drawBoldTextInBrightColors).toBe(true)
  })
})
