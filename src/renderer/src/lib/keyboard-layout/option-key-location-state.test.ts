import { describe, expect, it } from 'vitest'
import { createOptionKeyLocationTracker } from './option-key-location-state'

describe('createOptionKeyLocationTracker', () => {
  it('tracks both Option keys independently', () => {
    const tracker = createOptionKeyLocationTracker()
    tracker.keyDown({ key: 'Alt', location: 1 })
    tracker.keyDown({ key: 'Alt', location: 2 })
    expect(tracker.get()).toBe(3)

    tracker.keyUp({ key: 'Alt', location: 1 })
    expect(tracker.get()).toBe(2)
    tracker.keyUp({ key: 'Alt', location: 2 })
    expect(tracker.get()).toBe(0)
  })

  it('clears stale state on blur or an unknown Option transition', () => {
    const tracker = createOptionKeyLocationTracker()
    tracker.keyDown({ key: 'Alt', location: 1 })
    tracker.clear()
    expect(tracker.get()).toBe(0)

    tracker.keyDown({ key: 'Alt', location: 2 })
    tracker.keyUp({ key: 'Alt', location: 0 })
    expect(tracker.get()).toBe(0)
  })

  it('ignores non-Option keys', () => {
    const tracker = createOptionKeyLocationTracker()
    tracker.keyDown({ key: 'Shift', location: 1 })
    expect(tracker.get()).toBe(0)
  })
})
