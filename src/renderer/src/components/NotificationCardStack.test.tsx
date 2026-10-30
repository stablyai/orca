// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NOTIFICATION_CARD_STACK_HEIGHT_VAR } from '@/lib/notification-card-stack-height'
import { NotificationCardStack } from './NotificationCardStack'

let resize: (() => void) | null = null
let height = 0
let root: Root | null = null

const published = (): string =>
  document.documentElement.style.getPropertyValue(NOTIFICATION_CARD_STACK_HEIGHT_VAR)

beforeEach(() => {
  height = 0
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback
      }
      observe(): void {}
      disconnect(): void {}
    }
  )
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => height)
  root = createRoot(document.body.appendChild(document.createElement('div')))
})

afterEach(() => {
  act(() => root?.unmount())
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('NotificationCardStack', () => {
  it('publishes its height plus the gap so toasts sit above the cards, and clears it when empty', () => {
    height = 120
    act(() => root?.render(<NotificationCardStack>card</NotificationCardStack>))
    expect(published()).toBe('calc(120px + 0.5rem)')

    height = 0
    act(() => resize?.())
    expect(published()).toBe('')
  })

  it('clears its height on unmount, so the toaster returns to its own offset', () => {
    height = 80
    act(() => root?.render(<NotificationCardStack>card</NotificationCardStack>))
    act(() => root?.unmount())
    root = null
    expect(published()).toBe('')
  })
})
