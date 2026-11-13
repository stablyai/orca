import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUIStore, makePersistedUI } from './ui-slice-test-harness'

describe('GitHub task primary action persistence', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('defaults GitHub task primary action to Start and hydrates the last choice', () => {
    const store = createUIStore()

    expect(store.getState().githubTaskPrimaryAction).toBe('start')

    store.getState().hydratePersistedUI(
      makePersistedUI({
        githubTaskPrimaryAction: 'open-in-browser'
      })
    )
    expect(store.getState().githubTaskPrimaryAction).toBe('open-in-browser')

    store.getState().hydratePersistedUI(
      makePersistedUI({
        githubTaskPrimaryAction: 'resume' as never
      })
    )
    expect(store.getState().githubTaskPrimaryAction).toBe('start')
  })

  it('persists GitHub task primary action changes and skips no-ops', () => {
    const setUI = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { ui: { set: setUI } } })
    const store = createUIStore()

    store.getState().setGitHubTaskPrimaryAction('open-in-browser')
    expect(store.getState().githubTaskPrimaryAction).toBe('open-in-browser')
    expect(setUI).toHaveBeenCalledWith({ githubTaskPrimaryAction: 'open-in-browser' })

    store.getState().setGitHubTaskPrimaryAction('open-in-browser')
    expect(setUI).toHaveBeenCalledTimes(1)

    store.getState().setGitHubTaskPrimaryAction('start')
    expect(store.getState().githubTaskPrimaryAction).toBe('start')
    expect(setUI).toHaveBeenCalledWith({ githubTaskPrimaryAction: 'start' })
  })
})
