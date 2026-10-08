// @vitest-environment happy-dom
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import {
  getNativeViewOcclusionSnapshot,
  scheduleNativeViewOcclusionMeasurement,
  subscribeNativeViewOcclusion
} from '@/lib/native-view-occlusion'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from './context-menu'
import { Dialog, DialogContent } from './dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from './dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from './popover'

class TestResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

function installGeometry(): void {
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(10, 20, 30, 40)
  )
}

function distinguishMountedMenus(selector: string): void {
  document.querySelectorAll<HTMLElement>(selector).forEach((node, index) => {
    Object.defineProperty(node, 'getBoundingClientRect', {
      configurable: true,
      value: () => new DOMRect(10 + index * 40, 20, 30, 40)
    })
  })
  scheduleNativeViewOcclusionMeasurement()
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('marks an actual mounted Dialog overlay as window-wide and clears it when closed', async () => {
  installGeometry()
  const unsubscribe = subscribeNativeViewOcclusion(() => undefined)
  const view = render(
    <Dialog open>
      <DialogContent>body</DialogContent>
    </Dialog>
  )
  await waitFor(() => expect(getNativeViewOcclusionSnapshot().windowBlocked).toBe(true))
  view.rerender(
    <Dialog open={false}>
      <DialogContent>body</DialogContent>
    </Dialog>
  )
  await waitFor(() => expect(getNativeViewOcclusionSnapshot().windowBlocked).toBe(false))
  unsubscribe()
})

it('measures a real nonmodal Popover content and preserves its forwarded ref cleanup', async () => {
  installGeometry()
  const unsubscribe = subscribeNativeViewOcclusion(() => undefined)
  const forwarded: { current: HTMLDivElement | null } = { current: null }
  const view = render(
    <Popover open>
      <PopoverTrigger>trigger</PopoverTrigger>
      <PopoverContent ref={forwarded}>content</PopoverContent>
    </Popover>
  )
  await waitFor(() => expect(getNativeViewOcclusionSnapshot().rectangles).toHaveLength(1))
  expect(forwarded.current).not.toBeNull()
  view.unmount()
  await waitFor(() => expect(getNativeViewOcclusionSnapshot().rectangles).toHaveLength(0))
  expect(forwarded.current).toBeNull()
  unsubscribe()
})

it('registers both open dropdown content and an open submenu content', async () => {
  installGeometry()
  const unsubscribe = subscribeNativeViewOcclusion(() => undefined)
  render(
    <DropdownMenu open>
      <DropdownMenuTrigger>trigger</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuSub open>
          <DropdownMenuSubTrigger>more</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>nested</DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  )
  await waitFor(() =>
    expect(
      document.querySelectorAll(
        '[data-slot="dropdown-menu-content"], [data-slot="dropdown-menu-sub-content"]'
      )
    ).toHaveLength(2)
  )
  distinguishMountedMenus(
    '[data-slot="dropdown-menu-content"], [data-slot="dropdown-menu-sub-content"]'
  )
  await waitFor(() => expect(getNativeViewOcclusionSnapshot().rectangles).toHaveLength(2))
  unsubscribe()
})

it('registers both open context menu content and an open submenu content', async () => {
  installGeometry()
  const unsubscribe = subscribeNativeViewOcclusion(() => undefined)
  render(
    <ContextMenu open>
      <ContextMenuTrigger>trigger</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuSub open>
          <ContextMenuSubTrigger>more</ContextMenuSubTrigger>
          <ContextMenuSubContent>nested</ContextMenuSubContent>
        </ContextMenuSub>
      </ContextMenuContent>
    </ContextMenu>
  )
  await waitFor(() =>
    expect(
      document.querySelectorAll(
        '[data-slot="context-menu-content"], [data-slot="context-menu-sub-content"]'
      )
    ).toHaveLength(2)
  )
  distinguishMountedMenus(
    '[data-slot="context-menu-content"], [data-slot="context-menu-sub-content"]'
  )
  await waitFor(() => expect(getNativeViewOcclusionSnapshot().rectangles).toHaveLength(2))
  unsubscribe()
})
