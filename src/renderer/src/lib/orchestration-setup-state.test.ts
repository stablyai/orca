import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ORCHESTRATION_ENABLED_STORAGE_KEY,
  ORCHESTRATION_SETUP_STATE_EVENT,
  markOrchestrationSetupComplete
} from './orchestration-setup-state'

describe('orchestration setup state', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('marks setup complete and notifies listeners', () => {
    const localStorage = {
      getItem: vi.fn(),
      removeItem: vi.fn(),
      setItem: vi.fn()
    }
    const dispatchEvent = vi.fn()
    vi.stubGlobal('localStorage', localStorage)
    vi.stubGlobal('window', {
      dispatchEvent
    })

    markOrchestrationSetupComplete()

    expect(localStorage.setItem).toHaveBeenCalledWith(ORCHESTRATION_ENABLED_STORAGE_KEY, '1')
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: ORCHESTRATION_SETUP_STATE_EVENT })
    )
  })
})
