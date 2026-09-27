// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { revealMountedWorktreeElement } from './mounted-row-reveal'

afterEach(() => document.body.replaceChildren())

it('stops an obsolete animation without moving an already visible replacement', () => {
  const container = document.createElement('div')
  const element = document.createElement('div')
  element.id = 'visible-replacement'
  container.append(element)
  document.body.append(container)
  Object.defineProperty(container, 'clientHeight', { value: 600 })
  container.scrollTop = 400
  element.getBoundingClientRect = () => new DOMRect(0, 200, 200, 55)
  const scrollTo = vi.fn()
  const markScroll = vi.fn()
  container.scrollTo = scrollTo
  expect(
    revealMountedWorktreeElement(container, 'replacement', 'smooth', element.id, markScroll)
  ).toBe(element)
  expect(markScroll).toHaveBeenCalledExactlyOnceWith(400)
  expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 400, behavior: 'auto' })
})

it('does not stop another container when the exact option belongs elsewhere', () => {
  const container = document.createElement('div')
  const element = document.createElement('div')
  element.id = 'other-body-option'
  document.body.append(element)
  const scrollTo = vi.fn()
  container.scrollTo = scrollTo
  expect(revealMountedWorktreeElement(container, 'other', 'smooth', element.id)).toBeNull()
  expect(scrollTo).not.toHaveBeenCalled()
})
