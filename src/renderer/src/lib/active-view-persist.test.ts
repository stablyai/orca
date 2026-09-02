import { describe, expect, it } from 'vitest'
import { buildActiveViewUnloadPatch } from './active-view-persist'

describe('buildActiveViewUnloadPatch', () => {
  it('does not overwrite persisted UI before startup hydration completes', () => {
    expect(buildActiveViewUnloadPatch({ activeView: 'terminal', persistedUIReady: false })).toEqual(
      {}
    )
  })

  it('checkpoints the latest view after startup hydration completes', () => {
    expect(buildActiveViewUnloadPatch({ activeView: 'tasks', persistedUIReady: true })).toEqual({
      activeView: 'tasks'
    })
  })
})
