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

it('clears the marker when focus leaves the list from a focused row control', () => {
  document.body.innerHTML =
    '<div data-worktree-sidebar tabindex="0"><button id="header">Section</button></div><button id="outside">Outside</button>'
  const list = document.querySelector<HTMLElement>('[data-worktree-sidebar]')!
  const header = document.querySelector<HTMLElement>('#header')!
  const outside = document.querySelector<HTMLElement>('#outside')!
  renderHook(() => useListPointerFocusOrigin({ current: list }))

  header.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  header.focus()
  expect(list.hasAttribute('data-pointer-focus')).toBe(true)

  outside.focus()
  expect(list.hasAttribute('data-pointer-focus')).toBe(false)
})

it('keeps the marker while focus moves between the list and its row controls', () => {
  document.body.innerHTML =
    '<div data-worktree-sidebar tabindex="0"><button id="header">Section</button></div>'
  const list = document.querySelector<HTMLElement>('[data-worktree-sidebar]')!
  const header = document.querySelector<HTMLElement>('#header')!
  renderHook(() => useListPointerFocusOrigin({ current: list }))

  list.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  list.focus()
  header.focus()
  expect(list.hasAttribute('data-pointer-focus')).toBe(true)
  list.focus()
  expect(list.hasAttribute('data-pointer-focus')).toBe(true)
})
