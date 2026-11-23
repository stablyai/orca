import { expect, it } from 'vitest'
import {
  dismissPointerIsInsideBorderBox,
  isClientXInVerticalScrollbarGutter
} from './scrollbar-gutter-pointer'

const box = {
  offsetWidth: 120,
  clientWidth: 104,
  left: 10,
  right: 130,
  direction: 'ltr' as const
}

it('treats the right-edge gutter as the vertical scrollbar', () => {
  expect(isClientXInVerticalScrollbarGutter(box, 114)).toBe(true)
  expect(isClientXInVerticalScrollbarGutter(box, 130)).toBe(true)
  expect(isClientXInVerticalScrollbarGutter(box, 113)).toBe(false)
})

it('puts the gutter on the left when the list is RTL', () => {
  const rtl = { ...box, direction: 'rtl' as const }
  expect(isClientXInVerticalScrollbarGutter(rtl, 10)).toBe(true)
  expect(isClientXInVerticalScrollbarGutter(rtl, 26)).toBe(true)
  expect(isClientXInVerticalScrollbarGutter(rtl, 27)).toBe(false)
  expect(isClientXInVerticalScrollbarGutter(rtl, 120)).toBe(false)
})

it('ignores a list that is not overflowing', () => {
  expect(
    isClientXInVerticalScrollbarGutter({ ...box, offsetWidth: 104, clientWidth: 104 }, 130)
  ).toBe(false)
})

it('keeps a pointerdown-outside whose point is still inside the border box', () => {
  const border = { left: 10, top: 20, right: 130, bottom: 200 }
  expect(
    dismissPointerIsInsideBorderBox(
      { detail: { originalEvent: { clientX: 120, clientY: 40 } } },
      border
    )
  ).toBe(true)
  expect(
    dismissPointerIsInsideBorderBox(
      { detail: { originalEvent: { clientX: 131, clientY: 40 } } },
      border
    )
  ).toBe(false)
  expect(dismissPointerIsInsideBorderBox({}, border)).toBe(false)
})
