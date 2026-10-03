import { describe, expect, it } from 'vitest'
import { getGlassCopyPlatform, windowBlurDescription } from './terminal-window-glass-copy'

describe('getGlassCopyPlatform', () => {
  it('maps desktop platforms to their glass copy', () => {
    expect(getGlassCopyPlatform('darwin', false)).toBe('mac')
    expect(getGlassCopyPlatform('win32', false)).toBe('windows')
    expect(getGlassCopyPlatform('linux', false)).toBe('linux')
  })

  it('treats any browser web client as web, even on macOS', () => {
    expect(getGlassCopyPlatform('darwin', true)).toBe('web')
    expect(windowBlurDescription('web')).not.toContain('Chat Glass Opacity')
  })
})
