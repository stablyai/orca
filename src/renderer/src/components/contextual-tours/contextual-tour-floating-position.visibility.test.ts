// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as FloatingUI from '@floating-ui/dom'

const { updates } = vi.hoisted(() => ({ updates: [] as (() => void)[] }))
vi.mock('@floating-ui/dom', async (importOriginal) => ({
  ...(await importOriginal<typeof FloatingUI>()),
  autoUpdate: (_target: Element, _floating: Element, update: () => void) => {
    updates.push(update)
    update()
    return () => {}
  }
}))

import { watchContextualTourFloatingPosition } from './contextual-tour-floating-position'

let visibility: 'visible' | 'hidden'
let stop: (() => void) | undefined

function changeVisibility(next: 'visible' | 'hidden'): void {
  visibility = next
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  vi.useFakeTimers()
  updates.length = 0
  visibility = 'hidden'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  Object.defineProperty(document.documentElement, 'clientWidth', {
    configurable: true,
    value: 1280
  })
  Object.defineProperty(document.documentElement, 'clientHeight', {
    configurable: true,
    value: 960
  })
})

afterEach(() => {
  stop?.()
  stop = undefined
  document.body.replaceChildren()
  changeVisibility('visible')
  vi.useRealTimers()
})

it('publishes positions only from the current visible owner, including after hide and return', async () => {
  const target = document.createElement('button')
  const panel = document.createElement('section')
  const arrow = document.createElement('div')
  let top = 200
  Object.defineProperty(target, 'getBoundingClientRect', {
    value: () => new DOMRect(100, top, 120, 40)
  })
  Object.defineProperty(target, 'offsetWidth', { value: 120 })
  Object.defineProperty(target, 'offsetHeight', { value: 40 })
  Object.defineProperty(panel, 'getBoundingClientRect', {
    value: () => new DOMRect(0, 0, 200, 100)
  })
  Object.defineProperty(panel, 'offsetWidth', { value: 200 })
  Object.defineProperty(panel, 'offsetHeight', { value: 100 })
  Object.defineProperty(arrow, 'offsetWidth', { value: 18 })
  Object.defineProperty(arrow, 'offsetHeight', { value: 8 })
  panel.style.cssText = 'position:fixed;width:200px;height:100px'
  target.style.cssText = 'width:120px;height:40px'
  panel.appendChild(arrow)
  document.body.append(target, panel)
  const delivered: (number | string | undefined)[] = []
  stop = watchContextualTourFloatingPosition({
    arrowElement: arrow,
    floatingElement: panel,
    panelHost: null,
    targetElement: target,
    onPosition: (position) => delivered.push(position.panelPosition.top)
  })
  await vi.advanceTimersByTimeAsync(0)
  expect(delivered).toEqual([])

  changeVisibility('visible')
  await vi.advanceTimersByTimeAsync(0)
  expect(delivered).toEqual([170])
  const obsoleteUpdate = updates[0]!

  top = 300
  obsoleteUpdate()
  changeVisibility('hidden')
  await vi.advanceTimersByTimeAsync(0)
  expect(delivered).toEqual([170])

  top = 400
  changeVisibility('visible')
  await vi.advanceTimersByTimeAsync(0)
  expect(delivered).toEqual([170, 370])

  top = 500
  obsoleteUpdate()
  await vi.advanceTimersByTimeAsync(0)
  expect(delivered).toEqual([170, 370])
  updates.at(-1)!()
  await vi.advanceTimersByTimeAsync(0)
  expect(delivered).toEqual([170, 370, 470])

  top = 600
  updates.at(-1)!()
  stop()
  obsoleteUpdate()
  await vi.advanceTimersByTimeAsync(0)
  expect(delivered).toEqual([170, 370, 470])
})
