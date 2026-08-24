import { describe, expect, it } from 'vitest'
import { createTaskPageShortcutLoadFailureState } from './task-page-shortcut-load-state'

describe('createTaskPageShortcutLoadFailureState', () => {
  it('maps a 401 to a reconnect summary and keeps the raw details', () => {
    const state = createTaskPageShortcutLoadFailureState(new Error('Error 401: Unauthorized'))
    expect(state.stories).toEqual([])
    expect(state.error.title).toContain('Error 401')
    expect(state.error.title).toContain('Reconnect Shortcut')
    expect(state.error.details).toBe('Unauthorized')
  })

  it('infers rate limiting from the message text', () => {
    const state = createTaskPageShortcutLoadFailureState(new Error('Too many requests, slow down'))
    expect(state.error.title).toContain('429')
    expect(state.error.title).toContain('rate-limited')
  })

  it('falls back to a generic summary for unknown failures', () => {
    const state = createTaskPageShortcutLoadFailureState('boom')
    expect(state.error.title).toBe("Couldn't load Shortcut stories. Try again in a moment.")
    expect(state.error.details).toBe('Failed to load Shortcut stories.')
  })
})
