// @vitest-environment happy-dom

import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NativeChatDock } from './NativeChatDock'
import { NATIVE_CHAT_DOCK_FIT_ATTRIBUTE } from './native-chat-dock-fit'

// Records what each fit watcher observes and whether it was torn down.
type Watcher = { observed: Element[]; disconnected: boolean }
const watchers: Watcher[] = []

beforeEach(() => {
  watchers.length = 0
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private readonly watcher: Watcher = { observed: [], disconnected: false }
      constructor() {
        watchers.push(this.watcher)
      }
      observe(target: Element): void {
        this.watcher.observed.push(target)
      }
      unobserve(): void {}
      disconnect(): void {
        this.watcher.disconnected = true
      }
    }
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function pane(shown: boolean): React.JSX.Element {
  return (
    <div data-native-chat-root="true">
      <NativeChatDock shown={shown}>
        <div>Message box</div>
      </NativeChatDock>
    </div>
  )
}

const dock = (): Element | null => document.querySelector('[data-native-chat-dock]')
const root = (): Element => document.querySelector('[data-native-chat-root]')!
const live = () => watchers.filter((watcher) => !watcher.disconnected)

it('starts fitting a dock that first mounts hidden once it is shown', () => {
  const view = render(pane(false))
  expect(dock()).toBeNull()
  expect(watchers).toHaveLength(0)
  view.rerender(pane(true))
  expect(live()).toHaveLength(1)
  expect(live()[0]!.observed).toContain(dock())
})

it('stops fitting a hidden dock, clears its level, and fits it again when shown', () => {
  const view = render(pane(true))
  expect(live()).toHaveLength(1)
  root().setAttribute(NATIVE_CHAT_DOCK_FIT_ATTRIBUTE, 'queue composer')
  view.rerender(pane(false))
  expect(live()).toHaveLength(0)
  expect(root().hasAttribute(NATIVE_CHAT_DOCK_FIT_ATTRIBUTE)).toBe(false)
  view.rerender(pane(true))
  expect(live()).toHaveLength(1)
  expect(live()[0]!.observed).toContain(dock())
})
