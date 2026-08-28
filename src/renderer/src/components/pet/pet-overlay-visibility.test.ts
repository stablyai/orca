import { describe, expect, it } from 'vitest'
import { shouldRenderPetOverlay } from './pet-overlay-visibility'

const BASE = {
  persistedUIReady: true,
  petEnabled: true,
  petVisible: true,
  petDetached: false
}

describe('shouldRenderPetOverlay', () => {
  it('does not render before persisted UI hydration even when the feature is enabled', () => {
    expect(shouldRenderPetOverlay({ ...BASE, persistedUIReady: false })).toBe(false)
  })

  it('renders only after hydration when both pet switches allow it', () => {
    expect(shouldRenderPetOverlay(BASE)).toBe(true)
    expect(shouldRenderPetOverlay({ ...BASE, petVisible: false })).toBe(false)
    expect(shouldRenderPetOverlay({ ...BASE, petEnabled: false })).toBe(false)
  })

  it('yields to the detached pet window so the pet is never drawn twice', () => {
    expect(shouldRenderPetOverlay({ ...BASE, petDetached: true })).toBe(false)
  })
})
