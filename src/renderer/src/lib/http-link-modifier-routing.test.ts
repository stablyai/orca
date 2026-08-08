import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWebRuntimeSessionBrowserTab } from '@/runtime/web-runtime-session'
import {
  openHttpLink,
  registerHttpLinkStoreAccessor,
  resolveModifierRouting
} from './http-link-routing'

vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionBrowserTab: vi.fn(() => Promise.resolve(false))
}))

const createWebRuntimeSessionBrowserTabMock = vi.mocked(createWebRuntimeSessionBrowserTab)

describe('resolveModifierRouting', () => {
  it('is inert without the modifier regardless of settings', () => {
    for (const openLinksInApp of [true, false]) {
      for (const inverts of [true, false]) {
        expect(resolveModifierRouting(false, openLinksInApp, inverts)).toEqual({
          wantsOrca: false,
          wantsSystemBrowser: false
        })
      }
    }
  })

  // Why: the setting ships off, so the historical one-way escape hatch must be
  // byte-for-byte unchanged for every existing user.
  it('always forces the system browser when inverting is off', () => {
    expect(resolveModifierRouting(true, true, false)).toEqual({
      wantsOrca: false,
      wantsSystemBrowser: true
    })
    expect(resolveModifierRouting(true, false, false)).toEqual({
      wantsOrca: false,
      wantsSystemBrowser: true
    })
  })

  it('still reaches the system browser when inverting and links open in Orca', () => {
    expect(resolveModifierRouting(true, true, true)).toEqual({
      wantsOrca: false,
      wantsSystemBrowser: true
    })
  })

  it('reaches Orca when inverting and links open in the system browser', () => {
    expect(resolveModifierRouting(true, false, true)).toEqual({
      wantsOrca: true,
      wantsSystemBrowser: false
    })
  })

  it('only diverges from the legacy behavior when links open externally', () => {
    expect(resolveModifierRouting(true, true, true)).toEqual(
      resolveModifierRouting(true, true, false)
    )
    expect(resolveModifierRouting(true, false, true)).not.toEqual(
      resolveModifierRouting(true, false, false)
    )
  })
})

describe('modifier routing across link source owners', () => {
  const openUrlMock = vi.fn()
  const setActiveWorktreeMock = vi.fn()
  const createBrowserTabMock = vi.fn()
  const storeState = {
    settings: {} as {
      openLinksInApp?: boolean
      openLinksInAppModifierInverts?: boolean
      activeRuntimeEnvironmentId?: string | null
      browserTabHost?: 'local' | 'workspace'
    },
    setActiveWorktree: setActiveWorktreeMock,
    createBrowserTab: createBrowserTabMock
  }

  beforeEach(() => {
    vi.clearAllMocks()
    createWebRuntimeSessionBrowserTabMock.mockResolvedValue(false)
    registerHttpLinkStoreAccessor(() => storeState)
    vi.stubGlobal('window', { api: { shell: { openUrl: openUrlMock } } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('still lets the inverting modifier pull a local link into Orca', () => {
    storeState.settings = { openLinksInApp: false, openLinksInAppModifierInverts: true }

    openHttpLink('https://example.com/', {
      worktreeId: 'wt-1',
      modifierHeld: true,
      sourceOwner: { kind: 'local' }
    })

    expect(createBrowserTabMock).toHaveBeenCalledWith('wt-1', 'https://example.com/', {
      activate: true,
      browserRuntimeEnvironmentId: null
    })
  })

  it('never lets a modifier pull a runtime-owned link into Orca', async () => {
    createWebRuntimeSessionBrowserTabMock.mockResolvedValue(true)
    for (const inverts of [true, false]) {
      vi.clearAllMocks()
      storeState.settings = {
        openLinksInApp: false,
        openLinksInAppModifierInverts: inverts,
        activeRuntimeEnvironmentId: null,
        browserTabHost: 'workspace'
      }

      openHttpLink('https://example.com/', {
        worktreeId: 'wt-1',
        modifierHeld: true,
        sourceOwner: { kind: 'runtime', runtimeEnvironmentId: 'env-1' }
      })

      await vi.waitFor(() => {
        expect(openUrlMock).toHaveBeenCalledWith('https://example.com/')
      })
      expect(createBrowserTabMock).not.toHaveBeenCalled()
      expect(createWebRuntimeSessionBrowserTabMock).not.toHaveBeenCalled()
    }
  })

  it('falls back externally when the selected workspace runtime cannot create a tab', async () => {
    storeState.settings = {
      openLinksInApp: true,
      activeRuntimeEnvironmentId: null,
      browserTabHost: 'workspace'
    }

    openHttpLink('https://example.com/', {
      worktreeId: 'wt-1',
      sourceOwner: { kind: 'runtime', runtimeEnvironmentId: 'env-1' }
    })

    await vi.waitFor(() => {
      expect(openUrlMock).toHaveBeenCalledWith('https://example.com/')
    })
    expect(createWebRuntimeSessionBrowserTabMock).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      environmentId: 'env-1',
      url: 'https://example.com/'
    })
    expect(createBrowserTabMock).not.toHaveBeenCalled()
  })
})
