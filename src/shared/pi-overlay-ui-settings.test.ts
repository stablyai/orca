import { describe, expect, it } from 'vitest'
import { mergePiOverlayUiSettings } from './pi-overlay-ui-settings'

describe('mergePiOverlayUiSettings', () => {
  it('preserves user settings while forcing Orca-only Pi UI safety settings', () => {
    const merged = mergePiOverlayUiSettings({
      defaultProvider: 'amazon-bedrock',
      hideThinkingBlock: false,
      packages: ['npm:pi-web-access'],
      terminal: {
        showImages: false,
        clearOnShrink: false
      }
    })

    expect(merged).toEqual({
      defaultProvider: 'amazon-bedrock',
      hideThinkingBlock: true,
      packages: ['npm:pi-web-access'],
      terminal: {
        showImages: false,
        clearOnShrink: true
      }
    })
  })

  it('creates a valid settings object from malformed shapes', () => {
    expect(mergePiOverlayUiSettings(null)).toEqual({
      hideThinkingBlock: true,
      terminal: { clearOnShrink: true }
    })
    expect(mergePiOverlayUiSettings({ terminal: 'compact' })).toEqual({
      hideThinkingBlock: true,
      terminal: { clearOnShrink: true }
    })
  })
})
