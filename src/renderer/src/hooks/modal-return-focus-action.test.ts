import { describe, expect, it } from 'vitest'

import { resolveModalReturnFocusAction } from './modal-return-focus-action'

describe('resolveModalReturnFocusAction', () => {
  it('returns none when nothing was captured', () => {
    expect(resolveModalReturnFocusAction(null)).toEqual({ kind: 'none' })
  })

  it('routes browser surfaces through the browser focus channel', () => {
    expect(
      resolveModalReturnFocusAction({
        tabType: 'browser',
        worktreeId: 'wt-1',
        browserPageId: 'page-1',
        browserTarget: 'address-bar'
      })
    ).toEqual({ kind: 'browser', pageId: 'page-1', target: 'address-bar' })
  })

  it('falls back to the generic surface when a browser tab has no active page', () => {
    expect(
      resolveModalReturnFocusAction({
        tabType: 'browser',
        worktreeId: 'wt-1',
        browserPageId: null,
        browserTarget: 'webview'
      })
    ).toEqual({ kind: 'surface' })
  })

  it('restores the terminal/editor surface for non-browser tabs', () => {
    expect(
      resolveModalReturnFocusAction({
        tabType: 'terminal',
        worktreeId: 'wt-1',
        browserPageId: null,
        browserTarget: 'webview'
      })
    ).toEqual({ kind: 'surface' })
  })

  it('returns none when there is no worktree to restore into', () => {
    expect(
      resolveModalReturnFocusAction({
        tabType: 'terminal',
        worktreeId: null,
        browserPageId: null,
        browserTarget: 'webview'
      })
    ).toEqual({ kind: 'none' })
  })
})
