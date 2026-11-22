// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { KEEPS_FOCUS_ATTRIBUTE } from '@/lib/overlay-interaction/focus-keeping-press'
import { ActivityBarButton, type ActivityBarItem } from './activity-bar-buttons'
import { shouldFocusVaultSearchOnRoute } from './activity-bar-tab-focus'

const filesItem: ActivityBarItem = {
  id: 'explorer',
  icon: () => <svg />,
  title: 'Files',
  shortcut: '',
  labeledTab: true
}

describe('activity bar tab focus', () => {
  afterEach(() => cleanup())

  it('keeps a mouse press on a panel tab from taking focus', () => {
    const view = render(
      <ActivityBarButton item={filesItem} active layout="top" onClick={() => {}} />
    )
    const button = view.getByRole('button', { name: 'Files' })
    expect(button.hasAttribute(KEEPS_FOCUS_ATTRIBUTE)).toBe(true)
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    button.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('does not focus Agents search when the tab click itself opened the panel', () => {
    expect(
      shouldFocusVaultSearchOnRoute({
        open: true,
        creatingWorktree: false,
        tab: 'vault',
        effectiveTab: 'vault',
        settingsFocusRequested: false,
        routeFocusesVaultSearch: false
      })
    ).toBe(false)
  })

  it('still focuses Agents search for a keyboard or other route that asks for it', () => {
    expect(
      shouldFocusVaultSearchOnRoute({
        open: true,
        creatingWorktree: false,
        tab: 'vault',
        effectiveTab: 'vault',
        settingsFocusRequested: false,
        routeFocusesVaultSearch: true
      })
    ).toBe(true)
  })
})
