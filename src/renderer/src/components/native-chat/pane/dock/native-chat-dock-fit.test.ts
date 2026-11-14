// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from 'vitest'
import { NATIVE_CHAT_DOCK_FIT_ATTRIBUTE, runNativeChatDockFit } from './native-chat-dock-fit'

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

// Natural item heights at each fit level, as the CSS for that level would lay them out.
const QUEUE = [124, 28, 28, 28, 28, 28]
const CARD = [272, 272, 272, 272, 160, 160]
const COMPOSER = [150, 150, 60, 60, 60, 60]
const FLOOR = [80, 80, 80, 0, 0, 0]
const LEVELS = ['', 'queue', 'queue composer', 'queue composer transcript']

function dockOf(paneHeight: () => number): { root: HTMLElement; dock: HTMLElement } {
  document.body.innerHTML = `<div data-native-chat-root><div data-native-chat-dock>
    <div id="queue"><div data-native-chat-dock-pinned id="queue-header"></div></div>
    <div id="card" data-native-chat-dock-clip><div data-native-chat-dock-pinned id="footer"></div></div>
    <div id="composer"><div data-native-chat-dock-pinned id="box"></div></div>
  </div></div>`
  const root = document.querySelector<HTMLElement>('[data-native-chat-root]')!
  const dock = document.querySelector<HTMLElement>('[data-native-chat-dock]')!
  const level = (): number => {
    const tokens = root.getAttribute(NATIVE_CHAT_DOCK_FIT_ATTRIBUTE) ?? ''
    const index = LEVELS.indexOf(tokens)
    return index === -1 ? tokens.split(' ').length : index
  }
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fitting reads only `length`, which a one-rect array has.
    () => [new DOMRect()] as unknown as DOMRectList
  )
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    const at = level()
    const top = FLOOR[at]!
    // Items keep their natural height; the dock is what is left of the pane under the transcript floor.
    const queue = { top, bottom: top + QUEUE[at]! }
    const card = { top: queue.bottom, bottom: queue.bottom + CARD[at]! }
    const composer = { top: card.bottom, bottom: card.bottom + COMPOSER[at]! }
    const boxes: Record<string, { top: number; bottom: number }> = {
      queue,
      'queue-header': { top, bottom: top + 28 },
      card,
      footer: { top: card.bottom - 40, bottom: card.bottom },
      composer,
      box: composer
    }
    const box = this.hasAttribute('data-native-chat-dock')
      ? { top, bottom: paneHeight() }
      : (boxes[this.id] ?? { top: 0, bottom: 0 })
    return new DOMRect(0, box.top, 100, box.bottom - box.top)
  })
  return { root, dock }
}

it('steps up one fallback at a time and back down when the pane has room again', () => {
  let pane = 700
  const { root, dock } = dockOf(() => pane)
  expect(runNativeChatDockFit(root, dock)).toBe(0)
  expect(root.hasAttribute(NATIVE_CHAT_DOCK_FIT_ATTRIBUTE)).toBe(false)
  // Room for everything once the queue folds to its header.
  pane = 560
  expect(runNativeChatDockFit(root, dock)).toBe(1)
  expect(root.getAttribute(NATIVE_CHAT_DOCK_FIT_ATTRIBUTE)).toBe('queue')
  pane = 470
  expect(runNativeChatDockFit(root, dock)).toBe(2)
  pane = 390
  expect(runNativeChatDockFit(root, dock)).toBe(3)
  pane = 260
  expect(runNativeChatDockFit(root, dock)).toBe(4)
  pane = 700
  expect(runNativeChatDockFit(root, dock)).toBe(0)
  expect(root.hasAttribute(NATIVE_CHAT_DOCK_FIT_ATTRIBUTE)).toBe(false)
})

it('ends at the scrolling dock without measuring it when even the pinned parts cannot fit', () => {
  const { root, dock } = dockOf(() => 120)
  expect(runNativeChatDockFit(root, dock)).toBe(5)
  expect(root.getAttribute(NATIVE_CHAT_DOCK_FIT_ATTRIBUTE)).toBe(
    'queue composer transcript card dock'
  )
})

it('waits while a card animates its height, leaving the level as it was', () => {
  const { root, dock } = dockOf(() => 560)
  expect(runNativeChatDockFit(root, dock)).toBe(1)
  dock.querySelector('#card')!.setAttribute('data-native-chat-dock-animating', '')
  expect(runNativeChatDockFit(root, dock)).toBeNull()
  expect(root.getAttribute(NATIVE_CHAT_DOCK_FIT_ATTRIBUTE)).toBe('queue')
})
