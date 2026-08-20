import { describe, expect, it } from 'vitest'
import { petBuildFailureMessage } from './pet-from-image-message'
import { BUILD_PET_FAILURES } from './pet-from-image'

// Why: the real list, not a copy — a hand-written one silently stops covering
// reasons added later, which is exactly how the last gap got in.
const ALL = BUILD_PET_FAILURES

describe('petBuildFailureMessage', () => {
  it('has a message for every way the build can fail', () => {
    for (const reason of ALL) {
      const message = petBuildFailureMessage(reason)
      expect(message.length, `${reason} has no message`).toBeGreaterThan(0)
      expect(message, `${reason} leaks its code`).not.toContain(reason)
    }
  })

  it('tells the user what to do, not just what broke', () => {
    // Every cutout failure is recoverable by supplying a better image, so each
    // message has to say so — "could not import" leaves the user stuck.
    const actionable = ALL.filter((r) => r !== 'unknown-style' && r !== 'style-artwork-unavailable')
    for (const reason of actionable) {
      expect(petBuildFailureMessage(reason).toLowerCase(), reason).toMatch(
        /transparent|plain background|another image|crop/
      )
    }
  })

  it('names the background as the problem when the fill found nothing to remove', () => {
    expect(petBuildFailureMessage('background-not-separable').toLowerCase()).toContain('background')
  })

  it('says the character could not be made out when the shape is a slab', () => {
    expect(petBuildFailureMessage('no-character-shape').toLowerCase()).toMatch(/character|shape/)
  })
})
