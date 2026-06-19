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
        browserTarget: 'address-bar',
        terminalTabId: null,
        terminalLeafId: null
      })
    ).toEqual({ kind: 'browser', pageId: 'page-1', target: 'address-bar' })
  })

  it('falls back to the generic surface when a browser tab has no active page', () => {
    expect(
      resolveModalReturnFocusAction({
        tabType: 'browser',
        worktreeId: 'wt-1',
        browserPageId: null,
        browserTarget: 'webview',
        terminalTabId: null,
        terminalLeafId: null
      })
    ).toEqual({ kind: 'surface' })
  })

  it('restores a terminal tab through the scoped terminal focus path', () => {
    expect(
      resolveModalReturnFocusAction({
        tabType: 'terminal',
        worktreeId: 'wt-1',
        browserPageId: null,
        browserTarget: 'webview',
        terminalTabId: 'terminal-1',
        terminalLeafId: 'leaf-1'
      })
    ).toEqual({ kind: 'terminal', tabId: 'terminal-1', leafId: 'leaf-1' })
  })

  it('restores the editor surface before falling back to terminal focus', () => {
    expect(
      resolveModalReturnFocusAction({
        tabType: 'editor',
        worktreeId: 'wt-1',
        browserPageId: null,
        browserTarget: 'webview',
        terminalTabId: null,
        terminalLeafId: null
      })
    ).toEqual({ kind: 'editor' })
  })

  it('restores the simulator surface without using the terminal fallback', () => {
    expect(
      resolveModalReturnFocusAction({
        tabType: 'simulator',
        worktreeId: 'wt-1',
        browserPageId: null,
        browserTarget: 'webview',
        terminalTabId: null,
        terminalLeafId: null
      })
    ).toEqual({ kind: 'simulator' })
  })

  it('returns none when there is no worktree to restore into', () => {
    expect(
      resolveModalReturnFocusAction({
        tabType: 'terminal',
        worktreeId: null,
        browserPageId: null,
        browserTarget: 'webview',
        terminalTabId: null,
        terminalLeafId: null
      })
    ).toEqual({ kind: 'none' })
  })
})
