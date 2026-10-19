import { describe, expect, it, afterEach, vi } from 'vitest'
import {
  createKagiSessionLinkDraftState,
  resolveKagiSessionLinkDraftState
} from './KagiSessionLinkForm'

describe('KagiSessionLinkForm draft state', () => {
  it('keeps an unsaved draft while the persisted session link is unchanged', () => {
    const state = {
      ...createKagiSessionLinkDraftState('https://kagi.com/search?token=stored'),
      value: 'https://kagi.com/search?token=typed'
    }

    expect(resolveKagiSessionLinkDraftState(state, 'https://kagi.com/search?token=stored')).toBe(
      state
    )
  })

  it('reconciles the draft when the persisted session link changes', () => {
    const state = {
      ...createKagiSessionLinkDraftState('https://kagi.com/search?token=old'),
      value: 'https://kagi.com/search?token=typed'
    }

    expect(resolveKagiSessionLinkDraftState(state, 'https://kagi.com/search?token=new')).toEqual({
      persisted: 'https://kagi.com/search?token=new',
      value: 'https://kagi.com/search?token=new'
    })
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
