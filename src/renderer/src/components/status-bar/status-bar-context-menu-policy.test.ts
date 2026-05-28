import { describe, expect, it } from 'vitest'
import {
  STATUS_BAR_CONTEXT_MENU_EXEMPT_SELECTOR,
  shouldOpenStatusBarContextMenu
} from './status-bar-context-menu-policy'

function targetMatching(selector: string | null): EventTarget & {
  closest: (value: string) => Element | null
} {
  return {
    closest: (value: string) => (value === selector ? ({} as Element) : null)
  } as EventTarget & { closest: (value: string) => Element | null }
}

describe('shouldOpenStatusBarContextMenu', () => {
  it('opens for plain status-bar right-clicks', () => {
    expect(shouldOpenStatusBarContextMenu(targetMatching(null))).toBe(true)
  })

  it('ignores right-clicks inside exempt status-bar popovers', () => {
    expect(
      shouldOpenStatusBarContextMenu(targetMatching(STATUS_BAR_CONTEXT_MENU_EXEMPT_SELECTOR))
    ).toBe(false)
  })

  it('keeps the floating terminal context menu independent', () => {
    expect(shouldOpenStatusBarContextMenu(targetMatching('[data-floating-terminal-toggle]'))).toBe(
      false
    )
  })

  it('opens when the browser gives a non-element target', () => {
    expect(shouldOpenStatusBarContextMenu(null)).toBe(true)
  })
})
