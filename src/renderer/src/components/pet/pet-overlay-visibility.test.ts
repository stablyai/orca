import { describe, expect, it } from 'vitest'
import { shouldRenderPetOverlay } from './pet-overlay-visibility'

describe('shouldRenderPetOverlay', () => {
  it('does not render before persisted UI hydration even when the feature is enabled', () => {
    expect(
      shouldRenderPetOverlay({
        persistedUIReady: false,
        petEnabled: true,
        petVisible: true
      })
    ).toBe(false)
  })

  it('renders only after hydration when both pet switches allow it', () => {
    expect(
      shouldRenderPetOverlay({
        persistedUIReady: true,
        petEnabled: true,
        petVisible: true
      })
    ).toBe(true)
    expect(
      shouldRenderPetOverlay({
        persistedUIReady: true,
        petEnabled: true,
        petVisible: false
      })
    ).toBe(false)
    expect(
      shouldRenderPetOverlay({
        persistedUIReady: true,
        petEnabled: false,
        petVisible: true
      })
    ).toBe(false)
  })
})
