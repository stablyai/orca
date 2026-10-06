import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  openHttpLink,
  registerHttpLinkStoreAccessor,
  registerWorkspaceHttpLinkBrowserOpener
} from './http-link-routing'

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
