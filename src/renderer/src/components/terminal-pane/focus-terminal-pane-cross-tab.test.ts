// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
import { handleFocusTerminalPaneDetail } from './focus-terminal-pane-event'

function fixture() {
  const leafId = '11111111-1111-4111-8111-111111111111'
  if (!isTerminalLeafId(leafId)) {
    throw new Error('Expected synthetic leaf UUID')
  }
  const container = document.createElement('div')
  const order: string[] = []
  const collapseExpandedPane = vi.fn(() => order.push('collapse'))
  const manager = {
    getNumericIdForLeaf: vi.fn(() => 7),
    getPanes: () => [{ id: 7, leafId, container }],
    setActivePane: vi.fn(() => order.push('focus'))
  }
  return {
    leafId,
    manager,
    collapseExpandedPane,
    order,
    deps: {
      tabId: 'target',
      manager,
      collapseExpandedPane,
      acknowledgeAgents: vi.fn(),
      surfaceStaleAgentRow: vi.fn()
    }
  }
}

describe('cross-tab exact-leaf focus', () => {
  it('reveals an expanded target layout before focusing its first or last pane', () => {
    const f = fixture()
    handleFocusTerminalPaneDetail(
      { tabId: 'target', leafId: f.leafId, collapseExpandedPane: true },
      f.deps
    )
    expect(f.order).toEqual(['collapse', 'focus'])
    expect(f.manager.setActivePane).toHaveBeenCalledWith(7, { focus: true })
  })

  it('does not collapse an unrelated tab or a stale target leaf', () => {
    const f = fixture()
    handleFocusTerminalPaneDetail(
      { tabId: 'other', leafId: f.leafId, collapseExpandedPane: true },
      f.deps
    )
    handleFocusTerminalPaneDetail(
      {
        tabId: 'target',
        leafId: '22222222-2222-4222-8222-222222222222',
        collapseExpandedPane: true
      },
      f.deps
    )
    expect(f.collapseExpandedPane).not.toHaveBeenCalled()
    expect(f.manager.setActivePane).not.toHaveBeenCalled()
  })

  it('preserves expansion for existing focus-event callers', () => {
    const f = fixture()
    handleFocusTerminalPaneDetail({ tabId: 'target', leafId: f.leafId }, f.deps)
    expect(f.collapseExpandedPane).not.toHaveBeenCalled()
    expect(f.manager.setActivePane).toHaveBeenCalledWith(7, { focus: true })
  })
})
