import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { openHttpLink, registerHttpLinkStoreAccessor } from './http-link-routing'

const openUrlMock = vi.fn()
const setActiveWorktreeMock = vi.fn()
const createBrowserTabMock = vi.fn()

const storeState = {
  settings: undefined as
    | {
        openLinksInApp?: boolean
        openLinksInAppPreferencePrompted?: boolean
        activeRuntimeEnvironmentId?: string | null
      }
    | undefined,
  setActiveWorktree: setActiveWorktreeMock,
  createBrowserTab: createBrowserTabMock
}

beforeEach(() => {
  vi.clearAllMocks()
  storeState.settings = undefined
  registerHttpLinkStoreAccessor(() => storeState)
  vi.stubGlobal('window', {
    api: {
      shell: {
        openUrl: openUrlMock
      }
    }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('openHttpLink', () => {
  it('routes into Orca when openLinksInApp is on and a worktree is known', () => {
    storeState.settings = { openLinksInApp: true }

    openHttpLink('https://example.com/', { worktreeId: 'wt-1' })

    expect(setActiveWorktreeMock).toHaveBeenCalledWith('wt-1')
    expect(createBrowserTabMock).toHaveBeenCalledWith('wt-1', 'https://example.com/', {
      activate: true
    })
    expect(openUrlMock).not.toHaveBeenCalled()
  })

  it('defaults to the system browser when settings have not hydrated', () => {
    storeState.settings = undefined

    openHttpLink('https://example.com/', { worktreeId: 'wt-1' })

    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/')
    expect(createBrowserTabMock).not.toHaveBeenCalled()
  })

  it('routes floating workspace links into Orca without changing the active repo worktree', () => {
    storeState.settings = { openLinksInApp: true }

    openHttpLink('https://example.com/', { worktreeId: FLOATING_TERMINAL_WORKTREE_ID })

    expect(setActiveWorktreeMock).not.toHaveBeenCalled()
    expect(createBrowserTabMock).toHaveBeenCalledWith(
      FLOATING_TERMINAL_WORKTREE_ID,
      'https://example.com/',
      { activate: true }
    )
    expect(openUrlMock).not.toHaveBeenCalled()
  })

  it('routes to the system browser when openLinksInApp is off', () => {
    storeState.settings = { openLinksInApp: false }

    openHttpLink('https://example.com/', { worktreeId: 'wt-1' })

    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/')
    expect(createBrowserTabMock).not.toHaveBeenCalled()
  })

  it('routes to the system browser when a remote runtime environment is active', () => {
    storeState.settings = { openLinksInApp: true, activeRuntimeEnvironmentId: 'env-1' }

    openHttpLink('https://example.com/', { worktreeId: 'wt-1' })

    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/')
    expect(createBrowserTabMock).not.toHaveBeenCalled()
    expect(setActiveWorktreeMock).not.toHaveBeenCalled()
  })

  it('routes to the system browser when no worktree id is provided', () => {
    storeState.settings = { openLinksInApp: true }

    openHttpLink('https://example.com/', { worktreeId: '' })

    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/')
    expect(createBrowserTabMock).not.toHaveBeenCalled()
  })

  it('forceSystemBrowser overrides the setting even when a worktree is active', () => {
    storeState.settings = { openLinksInApp: true }

    openHttpLink('https://example.com/', { worktreeId: 'wt-1', forceSystemBrowser: true })

    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/')
    expect(createBrowserTabMock).not.toHaveBeenCalled()
    expect(setActiveWorktreeMock).not.toHaveBeenCalled()
  })

  it('force-orca-if-supported opens in Orca without changing the default', () => {
    storeState.settings = { openLinksInApp: false }

    openHttpLink('https://example.com/', {
      worktreeId: 'wt-1',
      routeMode: 'force-orca-if-supported'
    })

    expect(createBrowserTabMock).toHaveBeenCalledWith('wt-1', 'https://example.com/', {
      activate: true
    })
    expect(openUrlMock).not.toHaveBeenCalled()
  })

  it('does not force Orca routing before settings hydrate', () => {
    storeState.settings = undefined

    openHttpLink('https://example.com/', {
      worktreeId: 'wt-1',
      routeMode: 'force-orca-if-supported'
    })

    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/')
    expect(createBrowserTabMock).not.toHaveBeenCalled()
  })

  it('keeps terminal links in the system browser while connection lookup is unresolved', () => {
    storeState.settings = { openLinksInApp: true }

    openHttpLink('https://example.com/', {
      worktreeId: 'wt-1',
      connectionId: undefined
    })

    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/')
    expect(createBrowserTabMock).not.toHaveBeenCalled()
  })

  it('alternate opens in Orca once when the default is system browser', () => {
    storeState.settings = { openLinksInApp: false }

    openHttpLink('https://example.com/', { worktreeId: 'wt-1', routeMode: 'alternate' })

    expect(createBrowserTabMock).toHaveBeenCalledWith('wt-1', 'https://example.com/', {
      activate: true
    })
    expect(openUrlMock).not.toHaveBeenCalled()
  })

  it('alternate opens in the system browser once when the default is Orca', () => {
    storeState.settings = { openLinksInApp: true }

    openHttpLink('https://example.com/', { worktreeId: 'wt-1', routeMode: 'alternate' })

    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/')
    expect(createBrowserTabMock).not.toHaveBeenCalled()
  })

  it('keeps force-orca-if-supported in the system browser for SSH-backed worktrees', () => {
    storeState.settings = { openLinksInApp: false }

    openHttpLink('https://example.com/', {
      worktreeId: 'wt-1',
      routeMode: 'force-orca-if-supported',
      connectionId: 'ssh-1'
    })

    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/')
    expect(createBrowserTabMock).not.toHaveBeenCalled()
  })

  it('keeps default routing in the system browser for SSH-backed worktrees', () => {
    storeState.settings = { openLinksInApp: true }

    openHttpLink('https://example.com/', {
      worktreeId: 'wt-1',
      connectionId: 'ssh-1'
    })

    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/')
    expect(createBrowserTabMock).not.toHaveBeenCalled()
  })
})
