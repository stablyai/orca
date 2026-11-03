import { describe, expect, it } from 'vitest'
import {
  createBrowserHomePageDraftState,
  resolveBrowserHomePageDraftState
} from './browser-home-page-draft-state'

describe('BrowserPane home page draft state', () => {
  it('keeps an unsaved draft while the persisted home page is unchanged', () => {
    const state = {
      ...createBrowserHomePageDraftState('https://example.com'),
      value: 'https://typed.example.com'
    }

    expect(resolveBrowserHomePageDraftState(state, 'https://example.com')).toBe(state)
  })

  it('reconciles the draft when the persisted home page changes externally', () => {
    const state = {
      ...createBrowserHomePageDraftState('https://old.example.com'),
      value: 'https://typed.example.com'
    }

    expect(resolveBrowserHomePageDraftState(state, 'https://new.example.com')).toEqual({
      persisted: 'https://new.example.com',
      value: 'https://new.example.com'
    })
  })
})
