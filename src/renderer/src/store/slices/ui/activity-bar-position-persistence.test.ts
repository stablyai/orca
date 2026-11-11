import { describe, expect, it } from 'vitest'
import { sanitizeActivityBarPosition } from './ui-slice-hydration-sanitizers'
import { createUIStore, makePersistedUI } from './ui-slice-test-harness'

describe('activity bar position persistence', () => {
  it('restores Side on hydration', () => {
    const store = createUIStore()
    store.getState().hydratePersistedUI(makePersistedUI({ activityBarPosition: 'side' }), 'startup')
    expect(store.getState().activityBarPosition).toBe('side')
  })

  it('falls back to Top for a value the layout cannot render', () => {
    expect(sanitizeActivityBarPosition('left')).toBe('top')
  })
})
