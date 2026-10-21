import { describe, expect, it, vi, afterEach } from 'vitest'
import { toggleAutoRenameBranchFromWork } from './ContextualTourControl'
import { CONTEXTUAL_TOUR_ENABLE_AUTO_WORKSPACE_NAME_EVENT } from './contextual-tour-composer-events'

describe('toggleAutoRenameBranchFromWork', () => {
  it('clears the generated workspace name when enabling first-message auto-name', () => {
    const updateSettings = vi.fn()
    const dispatchEvent = vi.fn()

    toggleAutoRenameBranchFromWork({
      enabled: false,
      updateSettings,
      dispatchEvent
    })

    expect(updateSettings).toHaveBeenCalledWith({ autoRenameBranchFromWork: true })
    expect(dispatchEvent).toHaveBeenCalledTimes(1)
    expect(dispatchEvent.mock.calls[0]?.[0]).toMatchObject({
      type: CONTEXTUAL_TOUR_ENABLE_AUTO_WORKSPACE_NAME_EVENT
    })
  })

  it('does not clear the workspace name when disabling first-message auto-name', () => {
    const updateSettings = vi.fn()
    const dispatchEvent = vi.fn()

    toggleAutoRenameBranchFromWork({
      enabled: true,
      updateSettings,
      dispatchEvent
    })

    expect(updateSettings).toHaveBeenCalledWith({ autoRenameBranchFromWork: false })
    expect(dispatchEvent).not.toHaveBeenCalled()
  })
})

const { rejectAppStoreAccess } = vi.hoisted(() => ({
  rejectAppStoreAccess: vi.fn(() => {
    throw new Error('Pure helper tests must not access the app store')
  })
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(rejectAppStoreAccess, {
    getState: rejectAppStoreAccess,
    getInitialState: rejectAppStoreAccess,
    setState: rejectAppStoreAccess,
    subscribe: rejectAppStoreAccess
  })
}))

afterEach(() => {
  expect(rejectAppStoreAccess).not.toHaveBeenCalled()
})
