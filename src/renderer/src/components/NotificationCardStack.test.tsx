// @vitest-environment happy-dom

import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NOTIFICATION_CARD_STACK_HEIGHT_VAR } from '@/lib/notification-card-stack-height'
import {
  NOTIFICATION_CARD_COMPOSER_CLEARANCE_VAR,
  useNotificationCardComposerClearance
} from '@/lib/notification-card-composer-clearance'
import { useNotificationCardLayoutVarReader } from '@/lib/notification-card-layout-vars'
import { NotificationCardStack } from './NotificationCardStack'

let resize: (() => void) | null = null
let height = 0
let root: Root | null = null

const toasterVar = (name: string): string =>
  document.querySelector<HTMLElement>('[data-toaster]')?.style.getPropertyValue(name) ?? ''
const published = (): string => toasterVar(NOTIFICATION_CARD_STACK_HEIGHT_VAR)
const clearance = (): string => toasterVar(NOTIFICATION_CARD_COMPOSER_CLEARANCE_VAR)

type Box = { left: number; right: number; top: number; bottom: number }
// happy-dom's viewport is 1024 x 768; the cards' column is x 648-1008 as at 1024 px in Orca.
const CARD_COLUMN: Box = { left: 648, right: 1008, top: 0, bottom: 0 }
const rects = new Map<string, Box>()

function Composer({ id }: { id: string }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useNotificationCardComposerClearance(ref, true)
  return <div ref={ref} data-box={id} />
}

function ToasterStandIn(): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useNotificationCardLayoutVarReader(ref)
  return <div ref={ref} data-toaster="" />
}

function Corner(): React.JSX.Element {
  return (
    <>
      <ToasterStandIn />
      <NotificationCardStack>card</NotificationCardStack>
    </>
  )
}

beforeEach(() => {
  height = 0
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  )
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => height)
  rects.clear()
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    const box = this.dataset.box ? rects.get(this.dataset.box) : CARD_COLUMN
    return DOMRect.fromRect(
      box
        ? { x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top }
        : {}
    )
  })
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
    act(() => root?.render(<Corner />))
    expect(published()).toBe('calc(120px + 0.5rem)')

    height = 0
    act(() => resize?.())
    expect(published()).toBe('')
  })

  it('clears its height on unmount, so the toaster returns to its own offset', () => {
    height = 80
    act(() => root?.render(<Corner />))
    act(() => root?.unmount())
    root = null
    expect(published()).toBe('')
  })

  it('lifts the cards above a chat composer they would cover, and drops back when it goes', () => {
    height = 120
    rects.set('chat', { left: 300, right: 1010, top: 650, bottom: 740 })
    act(() =>
      root?.render(
        <>
          <Composer id="chat" />
          <Corner />
        </>
      )
    )
    expect(clearance()).toBe('calc(118px + 0.5rem)')
    expect(document.documentElement.getAttribute('style')).toBeNull()
    const setProperty = vi.spyOn(CSSStyleDeclaration.prototype, 'setProperty')
    act(() => resize?.())
    expect(setProperty).not.toHaveBeenCalled()

    act(() => root?.render(<Corner />))
    expect(clearance()).toBe('')
  })

  it('leaves the cards in place for composers beside them, above them, hidden, or with no cards', () => {
    height = 120
    rects.set('beside', { left: 0, right: 600, top: 650, bottom: 740 })
    rects.set('above', { left: 300, right: 1010, top: 300, bottom: 400 })
    rects.set('hidden', { left: 0, right: 0, top: 0, bottom: 0 })
    act(() =>
      root?.render(
        <>
          <Composer id="beside" />
          <Composer id="above" />
          <Composer id="hidden" />
          <Corner />
        </>
      )
    )
    expect(clearance()).toBe('')

    rects.set('beside', { left: 300, right: 1010, top: 650, bottom: 740 })
    height = 0
    act(() => resize?.())
    expect(clearance()).toBe('')
  })
})
