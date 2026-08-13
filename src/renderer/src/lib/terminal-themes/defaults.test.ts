import { describe, expect, it } from 'vitest'
import { LIGHT_CONTENT_SURFACE_HEX } from '../light-surface-tokens'
import { DEFAULT_TERMINAL_THEMES } from './defaults'

describe('default terminal themes', () => {
  it('paints the default light terminal on the shared cream content surface', () => {
    const light = DEFAULT_TERMINAL_THEMES['Builtin Tango Light']
    expect(light.background).toBe(LIGHT_CONTENT_SURFACE_HEX)
    // cursorAccent sits under the cursor block, so it must follow the background.
    expect(light.cursorAccent).toBe(LIGHT_CONTENT_SURFACE_HEX)
  })

  it('leaves the default dark terminal untouched', () => {
    expect(DEFAULT_TERMINAL_THEMES['Ghostty Default Style Dark'].background).toBe('#282c34')
  })
})
