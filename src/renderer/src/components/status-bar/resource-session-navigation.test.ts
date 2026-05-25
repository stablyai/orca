import { describe, expect, it, vi } from 'vitest'
import {
  isResourceSessionActivationKey,
  navigateResourceSessionToTab,
  type ResourceSessionNavigationDeps
} from './resource-session-navigation'

const TAB_ID = 'tab-1'
const OTHER_TAB_ID = 'tab-2'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

function makeDeps(events: string[] = []): ResourceSessionNavigationDeps {
  return {
    tabsByWorktree: {
      'wt-1': [{ id: TAB_ID }],
      'wt-2': [{ id: OTHER_TAB_ID }]
    },
    setOpen: vi.fn((open: boolean) => events.push(`open:${open}`)),
    setActiveView: vi.fn((view: 'terminal') => events.push(`view:${view}`)),
    activateAndRevealWorktree: vi.fn((worktreeId: string) => {
      events.push(`worktree:${worktreeId}`)
    }),
    activateTabAndFocusPane: vi.fn((tabId: string, leafId: string | null) => {
      events.push(`tab:${tabId}:${leafId ?? 'null'}`)
    })
  }
}

describe('resource session navigation', () => {
  it('closes the popover first, reveals the owning worktree, and focuses a matching pane', () => {
    const events: string[] = []
    const deps = makeDeps(events)

    navigateResourceSessionToTab(TAB_ID, `${TAB_ID}:${LEAF_ID}`, deps)

    expect(events).toEqual([
      `open:false`,
      'worktree:wt-1',
      'view:terminal',
      `tab:${TAB_ID}:${LEAF_ID}`
    ])
    expect(deps.activateTabAndFocusPane).toHaveBeenCalledWith(TAB_ID, LEAF_ID, {
      flashFocusedPane: true,
      scrollToBottomIfOutputSinceLastView: true
    })
  })

  it('degrades malformed and mismatched pane keys to tab-only activation', () => {
    const malformed = makeDeps()
    navigateResourceSessionToTab(TAB_ID, `${TAB_ID}:1`, malformed)
    expect(malformed.activateTabAndFocusPane).toHaveBeenCalledWith(TAB_ID, null, {
      flashFocusedPane: true,
      scrollToBottomIfOutputSinceLastView: true
    })

    const mismatched = makeDeps()
    navigateResourceSessionToTab(TAB_ID, `${OTHER_TAB_ID}:${LEAF_ID}`, mismatched)
    expect(mismatched.activateTabAndFocusPane).toHaveBeenCalledWith(TAB_ID, null, {
      flashFocusedPane: true,
      scrollToBottomIfOutputSinceLastView: true
    })
  })

  it('still activates the tab and switches to terminal when the worktree mapping is stale', () => {
    const deps = makeDeps()
    deps.tabsByWorktree = {}

    navigateResourceSessionToTab(TAB_ID, `${TAB_ID}:${LEAF_ID}`, deps)

    expect(deps.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(deps.setActiveView).toHaveBeenCalledWith('terminal')
    expect(deps.activateTabAndFocusPane).toHaveBeenCalledWith(TAB_ID, LEAF_ID, {
      flashFocusedPane: true,
      scrollToBottomIfOutputSinceLastView: true
    })
  })

  it('keeps keyboard activation equivalent to click for Enter and Space only', () => {
    expect(isResourceSessionActivationKey('Enter')).toBe(true)
    expect(isResourceSessionActivationKey(' ')).toBe(true)
    expect(isResourceSessionActivationKey('Escape')).toBe(false)
  })
})
