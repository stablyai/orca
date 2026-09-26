// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import {
  beginWorktreeListKeyboardNavigation,
  endWorktreeListKeyboardNavigation,
  isWorktreeListKeyboardNavigationActive
} from './worktree-list-keyboard-navigation'

function focusable(): HTMLDivElement {
  const element = document.createElement('div')
  element.tabIndex = 0
  document.body.append(element)
  return element
}

afterEach(() => {
  endWorktreeListKeyboardNavigation()
  document.body.innerHTML = ''
})

describe('workspace list keyboard navigation', () => {
  it('stays active while the list keeps focus', () => {
    const list = focusable()
    list.focus()

    beginWorktreeListKeyboardNavigation(list)

    expect(isWorktreeListKeyboardNavigationActive()).toBe(true)
  })

  it('is inactive when the list does not have focus', () => {
    const list = focusable()

    beginWorktreeListKeyboardNavigation(list)

    expect(isWorktreeListKeyboardNavigationActive()).toBe(false)
  })

  it('ends when focus leaves the list and does not revive when focus returns', () => {
    const list = focusable()
    const elsewhere = focusable()
    list.focus()
    beginWorktreeListKeyboardNavigation(list)

    elsewhere.focus()
    list.focus()

    expect(isWorktreeListKeyboardNavigationActive()).toBe(false)
  })

  it('ends on a click inside the list', () => {
    const list = focusable()
    const card = document.createElement('div')
    list.append(card)
    list.focus()
    beginWorktreeListKeyboardNavigation(list)

    card.dispatchEvent(new Event('pointerdown', { bubbles: true }))

    expect(isWorktreeListKeyboardNavigationActive()).toBe(false)
    expect(document.activeElement).toBe(list)
  })
})
