import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isChecksPanelHostedReviewSystemBrowserModifier,
  openChecksPanelHostedReviewUrl,
  resolveChecksPanelHostedReviewHttpOpenOptions,
  resolveChecksPanelHostedReviewModifierDestination
} from './checks-panel-hosted-review-click-routing'

const { openHttpLinkMock } = vi.hoisted(() => ({ openHttpLinkMock: vi.fn() }))

vi.mock('@/lib/http-link-routing', () => ({
  openHttpLink: openHttpLinkMock
}))

beforeEach(() => {
  openHttpLinkMock.mockReset()
})

describe('checks panel hosted review click routing', () => {
  it('maps Shift+Cmd to the routing modifier on macOS', () => {
    const event = { metaKey: true, ctrlKey: false, shiftKey: true }

    expect(isChecksPanelHostedReviewSystemBrowserModifier(event, true)).toBe(true)
    expect(resolveChecksPanelHostedReviewHttpOpenOptions(event, true, 'wt-1')).toEqual({
      worktreeId: 'wt-1',
      modifierHeld: true
    })
  })

  it('maps Shift+Ctrl to the routing modifier off macOS', () => {
    const event = { metaKey: false, ctrlKey: true, shiftKey: true }

    expect(isChecksPanelHostedReviewSystemBrowserModifier(event, false)).toBe(true)
    expect(resolveChecksPanelHostedReviewHttpOpenOptions(event, false, 'wt-1')).toEqual({
      worktreeId: 'wt-1',
      modifierHeld: true
    })
  })

  it('preserves the worktree id without the modifier on plain clicks', () => {
    expect(
      resolveChecksPanelHostedReviewHttpOpenOptions(
        { metaKey: false, ctrlKey: false, shiftKey: false },
        true,
        'wt-1'
      )
    ).toEqual({ worktreeId: 'wt-1' })
  })

  it('opens hosted review URLs without the modifier on plain clicks', () => {
    openChecksPanelHostedReviewUrl({
      url: 'https://github.com/acme/widgets/pull/123',
      event: { metaKey: false, ctrlKey: false, shiftKey: false },
      isMac: true,
      worktreeId: 'wt-1'
    })

    expect(openHttpLinkMock).toHaveBeenCalledWith('https://github.com/acme/widgets/pull/123', {
      worktreeId: 'wt-1'
    })
  })

  it('opens hosted review URLs with the modifier on Shift+Cmd clicks', () => {
    openChecksPanelHostedReviewUrl({
      url: 'https://github.com/acme/widgets/pull/123',
      event: { metaKey: true, ctrlKey: false, shiftKey: true },
      isMac: true,
      worktreeId: 'wt-1'
    })

    expect(openHttpLinkMock).toHaveBeenCalledWith('https://github.com/acme/widgets/pull/123', {
      worktreeId: 'wt-1',
      modifierHeld: true
    })
  })
})

describe('checks panel hosted review modifier hint destination', () => {
  it('names the system browser when a plain click already opens in Orca', () => {
    expect(resolveChecksPanelHostedReviewModifierDestination({ openLinksInApp: true }, true)).toBe(
      'system-browser'
    )
  })

  // Why: inverting is inert while links already open in Orca — both meanings of the
  // modifier land on the system browser, so checking inverts first would misname it.
  it('names the system browser when inverting is on and links already open in Orca', () => {
    expect(
      resolveChecksPanelHostedReviewModifierDestination(
        { openLinksInApp: true, openLinksInAppModifierInverts: true },
        true
      )
    ).toBe('system-browser')
  })

  // Why: this is the gesture the invert setting adds — without it the hint stays hidden
  // and the only way to reach Orca from this button is undiscoverable.
  it('names Orca when inverting is on and links open externally', () => {
    expect(
      resolveChecksPanelHostedReviewModifierDestination(
        { openLinksInApp: false, openLinksInAppModifierInverts: true },
        true
      )
    ).toBe('orca')
  })

  it('stays silent while inverting is off and links open externally', () => {
    expect(
      resolveChecksPanelHostedReviewModifierDestination({ openLinksInApp: false }, true)
    ).toBeNull()
    expect(resolveChecksPanelHostedReviewModifierDestination(null, true)).toBeNull()
  })

  // Why: openHttpLink refuses to route a remote-owned link into Orca, and openLinksInApp
  // cannot apply there either, so neither destination is reachable.
  it('stays silent while a remote runtime is active', () => {
    expect(
      resolveChecksPanelHostedReviewModifierDestination(
        { openLinksInApp: true, activeRuntimeEnvironmentId: 'remote-1' },
        true
      )
    ).toBeNull()
    expect(
      resolveChecksPanelHostedReviewModifierDestination(
        {
          openLinksInApp: false,
          openLinksInAppModifierInverts: true,
          activeRuntimeEnvironmentId: 'remote-1'
        },
        true
      )
    ).toBeNull()
  })

  // Why: openHttpLink trims before treating a runtime as active, so a blank id must
  // not suppress a hint for a click that still reaches Orca.
  it('ignores a blank runtime id', () => {
    expect(
      resolveChecksPanelHostedReviewModifierDestination(
        {
          openLinksInApp: false,
          openLinksInAppModifierInverts: true,
          activeRuntimeEnvironmentId: '   '
        },
        true
      )
    ).toBe('orca')
  })

  // Why: openHttpLink gates routing to Orca on a worktree id, so without one the
  // modifier lands in the system browser either way.
  it('stays silent without a worktree', () => {
    expect(
      resolveChecksPanelHostedReviewModifierDestination(
        { openLinksInApp: false, openLinksInAppModifierInverts: true },
        false
      )
    ).toBeNull()
    expect(
      resolveChecksPanelHostedReviewModifierDestination({ openLinksInApp: true }, false)
    ).toBeNull()
  })
})
