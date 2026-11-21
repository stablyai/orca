// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { NativeChatMarkdown } from './NativeChatMarkdown'

afterEach(cleanup)

// The number a browser draws: an item's `value`, else one past the item before.
function shownNumbers(list: HTMLOListElement): number[] {
  let next = Number(list.getAttribute('start') ?? 1)
  return [...list.children].map((item) => {
    const shown = Number(item.getAttribute('value') ?? next)
    next = shown + 1
    return shown
  })
}

it('keeps typed list numbers, but counts up a list that repeats one number', () => {
  const lists = [
    '1. a\n2. b\n4. c',
    '1. a\n1. b\n1. c',
    '1. a\n1. b\n3. c',
    '> 3. a\n> 3. b\n> 3. c'
  ]
  const { container } = render(
    <NativeChatMarkdown content={lists.join('\n\nnext\n\n')} variant="document" />
  )
  expect([...container.querySelectorAll('ol')].map(shownNumbers)).toEqual([
    [1, 2, 4],
    [1, 2, 3],
    [1, 1, 3],
    [3, 4, 5]
  ])
})
