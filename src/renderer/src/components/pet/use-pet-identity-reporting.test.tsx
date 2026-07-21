// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { usePetIdentityReporting } from './use-pet-presence'

/**
 * Regression cover for the popout identity bug: a popout window is a separate
 * renderer whose store starts at DEFAULT_PET_ID with no custom pets, so
 * reporting from it published Claudino to the authority and the operator's pet
 * visibly changed the moment it was dragged across.
 *
 * The rule under test is the narrow one that makes that structurally
 * impossible: a surface that does not know which pet the operator chose reports
 * NOTHING. Silence is the safe default because the authority keeps the last
 * known good id, whereas a guess overwrites it everywhere including the phone.
 */

const setPetId = vi.fn()

beforeEach(() => {
  setPetId.mockClear()
  ;(globalThis as unknown as { window: { api?: unknown } }).window.api = {
    petPresence: { setPetId }
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('usePetIdentityReporting', () => {
  it('publishes the operator’s pet when the surface knows it', () => {
    renderHook(() => usePetIdentityReporting('mini-gandalf-the-grey'))
    expect(setPetId).toHaveBeenCalledWith('mini-gandalf-the-grey')
  })

  it('stays silent when the surface has no identity to report', () => {
    // The popout case: reportsPetIdentity=false passes null until the store has
    // been hydrated from persisted UI.
    renderHook(() => usePetIdentityReporting(null))
    expect(setPetId).not.toHaveBeenCalled()
  })

  it('stays silent for undefined rather than falling back to a default', () => {
    renderHook(() => usePetIdentityReporting(undefined))
    expect(setPetId).not.toHaveBeenCalled()
  })

  it('does not republish an unchanged id on re-render', () => {
    // The authority no-ops on an unchanged id, but a surface that re-reports on
    // every render turns a cheap no-op into per-frame RPC traffic.
    const { rerender } = renderHook(() => usePetIdentityReporting('spike'))
    rerender()
    rerender()
    expect(setPetId).toHaveBeenCalledTimes(1)
  })

  it('publishes again when the operator switches pet', () => {
    const { rerender } = renderHook(
      ({ id }: { id: string | null }) => usePetIdentityReporting(id),
      { initialProps: { id: 'spike' as string | null } }
    )
    rerender({ id: 'mini-gandalf-the-grey' })
    expect(setPetId).toHaveBeenNthCalledWith(1, 'spike')
    expect(setPetId).toHaveBeenNthCalledWith(2, 'mini-gandalf-the-grey')
  })
})
