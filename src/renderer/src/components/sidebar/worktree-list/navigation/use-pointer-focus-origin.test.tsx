// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'

import { useListPointerFocusOrigin } from './use-pointer-focus-origin'

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

it('marks a clicked list as pointer-focused until focus leaves it', () => {
  document.body.innerHTML =
    '<div data-worktree-sidebar tabindex="0"><div role="option">Card</div></div><button>Outside</button>'
  const list = document.querySelector<HTMLElement>('[data-worktree-sidebar]')!
  const card = document.querySelector<HTMLElement>('[role="option"]')!
  const outside = document.querySelector<HTMLElement>('button')!
  renderHook(() => useListPointerFocusOrigin({ current: list }))

  card.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  list.focus()
  expect(list.hasAttribute('data-pointer-focus')).toBe(true)

  outside.focus()
  list.focus()
  expect(list.hasAttribute('data-pointer-focus')).toBe(false)
})
