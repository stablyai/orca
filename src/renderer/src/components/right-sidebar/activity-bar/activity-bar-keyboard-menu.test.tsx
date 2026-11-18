// @vitest-environment happy-dom
import { DndContext } from '@dnd-kit/core'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { RightSidebarTopActivityBar } from './right-sidebar-top-activity-bar'
import type { ActivityBarItem } from './activity-bar-buttons'

const item: ActivityBarItem = { id: 'explorer', title: 'Explorer', icon: () => null, shortcut: '' }
afterEach(cleanup)

it.each(['ContextMenu', 'F10'])('opens the tab menu with %s', (key) => {
  render(
    <DndContext>
      <RightSidebarTopActivityBar
        hasDesktopWindowChrome={false}
        topActivityStripRef={vi.fn()}
        topActivityLayout={{ visibleItems: [item], overflowItems: [], compactIds: new Set() }}
        effectiveTab="explorer"
        onSelectTab={vi.fn()}
        checksStatus={null}
        closeButton={null}
        activityBarPosition="top"
        onChangeActivityBarPosition={vi.fn()}
        arrangementItems={[item]}
      />
    </DndContext>
  )
  const button = screen.getByRole('button', { name: 'Explorer' })
  button.focus()
  fireEvent.keyDown(button, { key, shiftKey: key === 'F10' })
  expect(screen.getByRole('menuitem', { name: 'Reset tab order' })).toBeTruthy()
})

it('focuses the neighbouring tab after hiding with the keyboard', async () => {
  const plugin: ActivityBarItem = {
    id: 'plugin:test/panel',
    pluginKey: 'test',
    title: 'Plugin',
    icon: () => null,
    shortcut: ''
  }
  const items = [item, plugin]
  useAppStore.setState({ activityBarHidden: [], rightSidebarEffectiveTab: 'plugin:test/panel' })
  render(
    <DndContext>
      <RightSidebarTopActivityBar
        hasDesktopWindowChrome={false}
        topActivityStripRef={vi.fn()}
        topActivityLayout={{ visibleItems: items, overflowItems: [], compactIds: new Set() }}
        effectiveTab="plugin:test/panel"
        onSelectTab={vi.fn()}
        checksStatus={null}
        closeButton={null}
        activityBarPosition="top"
        onChangeActivityBarPosition={vi.fn()}
        arrangementItems={items}
      />
    </DndContext>
  )
  const button = screen.getByRole('button', { name: 'Plugin' })
  button.focus()
  fireEvent.keyDown(button, { key: 'F10', shiftKey: true })
  fireEvent.click(screen.getByRole('menuitem', { name: 'Hide' }))
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Explorer' }))
  )
  useAppStore.setState({ activityBarHidden: [], rightSidebarEffectiveTab: null })
})

function renderHideWithDelayedFrames(): { flushFrames: () => void; restore: () => void } {
  const frames: FrameRequestCallback[] = []
  const spy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
    frames.push(cb)
    return frames.length
  })
  const plugin: ActivityBarItem = {
    id: 'plugin:test/panel',
    pluginKey: 'test',
    title: 'Plugin',
    icon: () => null,
    shortcut: ''
  }
  const items = [item, plugin]
  useAppStore.setState({ activityBarHidden: [], rightSidebarEffectiveTab: 'plugin:test/panel' })
  render(
    <>
      <DndContext>
        <RightSidebarTopActivityBar
          hasDesktopWindowChrome={false}
          topActivityStripRef={vi.fn()}
          topActivityLayout={{ visibleItems: items, overflowItems: [], compactIds: new Set() }}
          effectiveTab="plugin:test/panel"
          onSelectTab={vi.fn()}
          checksStatus={null}
          closeButton={null}
          activityBarPosition="top"
          onChangeActivityBarPosition={vi.fn()}
          arrangementItems={items}
        />
      </DndContext>
      <textarea aria-label="Composer" />
    </>
  )
  const button = screen.getByRole('button', { name: 'Plugin' })
  button.focus()
  fireEvent.keyDown(button, { key: 'F10', shiftKey: true })
  fireEvent.click(screen.getByRole('menuitem', { name: 'Hide' }))
  return {
    flushFrames: () => {
      while (frames.length > 0) {
        frames.shift()?.(0)
      }
    },
    restore: () => {
      spy.mockRestore()
      useAppStore.setState({ activityBarHidden: [], rightSidebarEffectiveTab: null })
    }
  }
}

it('keeps composer focus taken between hiding and the pending focus handoff', () => {
  const { flushFrames, restore } = renderHideWithDelayedFrames()
  const composer = screen.getByRole('textbox', { name: 'Composer' })
  composer.focus()
  flushFrames()
  expect(document.activeElement).toBe(composer)
  cleanup()
  restore()
})

it('lands the pending hide handoff on the neighbour when focus is not taken', () => {
  const { flushFrames, restore } = renderHideWithDelayedFrames()
  flushFrames()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Explorer' }))
  cleanup()
  restore()
})
