import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isChecksPanelHostedReviewSystemBrowserModifier,
  openChecksPanelHostedReviewUrl,
  resolveChecksPanelHostedReviewHttpOpenOptions
} from './checks-panel-hosted-review-click-routing'

const { openHttpLinkMock } = vi.hoisted(() => ({ openHttpLinkMock: vi.fn() }))

vi.mock('@/lib/http-link-routing', () => ({
  openHttpLink: openHttpLinkMock
}))

beforeEach(() => {
  openHttpLinkMock.mockReset()
})

describe('checks panel hosted review click routing', () => {
  it('maps Shift+Cmd to forceSystemBrowser on macOS', () => {
    const event = { metaKey: true, ctrlKey: false, shiftKey: true }

    expect(isChecksPanelHostedReviewSystemBrowserModifier(event, true)).toBe(true)
    expect(resolveChecksPanelHostedReviewHttpOpenOptions(event, true, 'wt-1')).toEqual({
      worktreeId: 'wt-1',
      forceSystemBrowser: true
    })
  })

  it('maps Shift+Ctrl to forceSystemBrowser off macOS', () => {
    const event = { metaKey: false, ctrlKey: true, shiftKey: true }

    expect(isChecksPanelHostedReviewSystemBrowserModifier(event, false)).toBe(true)
    expect(resolveChecksPanelHostedReviewHttpOpenOptions(event, false, 'wt-1')).toEqual({
      worktreeId: 'wt-1',
      forceSystemBrowser: true
    })
  })

  it('preserves the worktree id without forceSystemBrowser on plain clicks', () => {
    expect(
      resolveChecksPanelHostedReviewHttpOpenOptions(
        { metaKey: false, ctrlKey: false, shiftKey: false },
        true,
        'wt-1'
      )
    ).toEqual({ worktreeId: 'wt-1' })
  })

  it('opens hosted review URLs without forceSystemBrowser on plain clicks', () => {
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

  it('opens hosted review URLs with forceSystemBrowser on Shift+Cmd clicks', () => {
    openChecksPanelHostedReviewUrl({
      url: 'https://github.com/acme/widgets/pull/123',
      event: { metaKey: true, ctrlKey: false, shiftKey: true },
      isMac: true,
      worktreeId: 'wt-1'
    })

    expect(openHttpLinkMock).toHaveBeenCalledWith('https://github.com/acme/widgets/pull/123', {
      worktreeId: 'wt-1',
      forceSystemBrowser: true
    })
  })
})
