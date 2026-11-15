// @vitest-environment happy-dom

import { expect, it, vi } from 'vitest'
import { shouldPreserveEditableFocus } from '@/lib/text-input/focus/editable-focus-preservation'

vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: () => ({
      setActiveTab: () => {},
      setActiveTabType: () => {},
      tabsByWorktree: {},
      activeWorktreeId: 'wt'
    })
  }
}))

import { activateTabAndFocusPane } from './activate-tab-and-focus-pane'

it('lets an explicit pane focus request win over sidebar list navigation', () => {
  document.body.innerHTML =
    '<div data-worktree-sidebar data-keyboard-navigation tabindex="0"></div>'
  document.querySelector<HTMLElement>('[data-worktree-sidebar]')!.focus()
  expect(shouldPreserveEditableFocus(document.activeElement)).toBe(true)

  activateTabAndFocusPane('tab', 'leaf')

  expect(shouldPreserveEditableFocus(document.activeElement)).toBe(false)
})
