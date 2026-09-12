import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  openHttpLink,
  registerHttpLinkStoreAccessor,
  registerWorkspaceHttpLinkBrowserOpener,
  resolveModifierRouting
} from './http-link-routing'

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
  const openRuntimeBrowserTabMock = vi.fn(() => Promise.resolve())
  const storeState = {
    settings: {} as {
      openLinksInApp?: boolean
      openLinksInAppModifierInverts?: boolean
      activeRuntimeEnvironmentId?: string | null
    },
    setActiveWorktree: setActiveWorktreeMock,
    createBrowserTab: createBrowserTabMock
  }

  beforeEach(() => {
    vi.clearAllMocks()
    registerHttpLinkStoreAccessor(() => storeState)
    registerWorkspaceHttpLinkBrowserOpener(openRuntimeBrowserTabMock)
    vi.stubGlobal('window', { api: { shell: { openUrl: openUrlMock } } })
  })

  afterEach(() => {
    registerWorkspaceHttpLinkBrowserOpener(null)
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
      activate: true
    })
  })

  it('lets an inverting modifier reach Orca on the owning runtime', () => {
    storeState.settings = {
      openLinksInApp: false,
      openLinksInAppModifierInverts: true,
      activeRuntimeEnvironmentId: null
    }

    openHttpLink('https://example.com/', {
      allowRemoteInApp: true,
      worktreeId: 'wt-1',
      modifierHeld: true,
      sourceOwner: { kind: 'runtime', runtimeEnvironmentId: 'env-1' }
    })

    expect(openRuntimeBrowserTabMock).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRuntimeEnvironmentId: 'env-1' })
    )
    expect(openUrlMock).not.toHaveBeenCalled()
  })

  it('keeps the legacy modifier on the system browser when inversion is off', () => {
    storeState.settings = {
      openLinksInApp: false,
      openLinksInAppModifierInverts: false,
      activeRuntimeEnvironmentId: null
    }

    openHttpLink('https://example.com/', {
      worktreeId: 'wt-1',
      modifierHeld: true,
      sourceOwner: { kind: 'runtime', runtimeEnvironmentId: 'env-1' }
    })

    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/')
    expect(openRuntimeBrowserTabMock).not.toHaveBeenCalled()
  })
})
