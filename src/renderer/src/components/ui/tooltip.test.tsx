// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip'

let root: Root | null = null

beforeEach(() => {
  vi.useFakeTimers()
  root = createRoot(document.body.appendChild(document.createElement('div')))
  act(() =>
    root!.render(
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button">Settings</button>
          </TooltipTrigger>
          <TooltipContent>Open settings</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  )
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
  vi.useRealTimers()
})

function trigger(): HTMLButtonElement {
  return document.querySelector('button')!
}

function tooltipOpen(): boolean {
  act(() => vi.runAllTimers())
  return document.querySelector('[role="tooltip"]') !== null
}

it('opens on keyboard focus', () => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }))
  act(() => trigger().focus())
  expect(tooltipOpen()).toBe(true)
})

it('stays closed when focus is restored after a pointer interaction', () => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }))
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  act(() => trigger().focus())
  expect(tooltipOpen()).toBe(false)
})

it.each([
  ['a click', ['pointerdown', 'mousedown', 'pointerup']],
  ['a touch that became a scroll', ['pointerdown', 'pointercancel']]
])('opens when assistive tech moves focus after %s', (_, events) => {
  for (const type of events) {
    document.body.dispatchEvent(new PointerEvent(type, { bubbles: true }))
  }
  vi.runAllTimers()
  // Screen-reader focus arrives as a focus event with no preceding input or script focus() call.
  act(() => {
    trigger().dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
  })
  expect(tooltipOpen()).toBe(true)
})

it('opens on hover', () => {
  act(() => {
    trigger().dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' })
    )
  })
  expect(tooltipOpen()).toBe(true)
})
