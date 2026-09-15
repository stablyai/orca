// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PopoutPortalContainerContext,
  useResolvedPortalContainer
} from '../ui/portal-container-context'
import { Sheet, SheetContent } from '../ui/sheet'
import { CommandDialog } from '../ui/command'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'

function fakeContextElement(body: HTMLElement, closed: boolean): HTMLElement {
  return {
    ownerDocument: { body, defaultView: { closed } }
  } as unknown as HTMLElement
}

describe('useResolvedPortalContainer', () => {
  it('returns undefined without a provider', () => {
    const { result } = renderHook(() => useResolvedPortalContainer(null))
    expect(result.current).toBeUndefined()
  })

  it('scopes portals to the popout document body instead of the nested container', () => {
    const popoutBody = document.createElement('div')
    const contextValue = fakeContextElement(popoutBody, false)
    const { result } = renderHook(() => useResolvedPortalContainer(null), {
      wrapper: ({ children }) => (
        <PopoutPortalContainerContext.Provider value={contextValue}>
          {children}
        </PopoutPortalContainerContext.Provider>
      )
    })
    expect(result.current).toBe(popoutBody)
    expect(result.current).not.toBe(contextValue)
  })

  it('falls back to undefined when the popout view is closed', () => {
    const contextValue = fakeContextElement(document.body, true)
    const { result } = renderHook(() => useResolvedPortalContainer(null), {
      wrapper: ({ children }) => (
        <PopoutPortalContainerContext.Provider value={contextValue}>
          {children}
        </PopoutPortalContainerContext.Provider>
      )
    })
    expect(result.current).toBeUndefined()
  })

  it('prefers an explicit portalContainer over context', () => {
    const override = document.createElement('div')
    const contextValue = fakeContextElement(document.body, false)
    const { result } = renderHook(() => useResolvedPortalContainer(override), {
      wrapper: ({ children }) => (
        <PopoutPortalContainerContext.Provider value={contextValue}>
          {children}
        </PopoutPortalContainerContext.Provider>
      )
    })
    expect(result.current).toBe(override)
  })
})

describe('overlays in popout container', () => {
  let root: Root | null = null
  let mount: HTMLDivElement
  let popoutBody: HTMLDivElement

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    mount.remove()
  })

  function renderInPopout(node: React.ReactNode): void {
    mount = document.createElement('div')
    document.body.appendChild(mount)
    popoutBody = document.createElement('div')
    const contextElement = fakeContextElement(popoutBody, false)
    root = createRoot(mount)
    act(() => {
      root!.render(
        <PopoutPortalContainerContext.Provider value={contextElement}>
          {node}
        </PopoutPortalContainerContext.Provider>
      )
    })
  }

  it('portals sheet content into the popout document body', () => {
    renderInPopout(
      <Sheet open>
        <SheetContent>sheet-body</SheetContent>
      </Sheet>
    )
    expect(popoutBody.querySelector('[data-slot="sheet-content"]')).not.toBeNull()
  })

  it('portals command dialog into the popout document body', () => {
    renderInPopout(
      <CommandDialog open>
        <div>palette-body</div>
      </CommandDialog>
    )
    expect(popoutBody.textContent).toContain('palette-body')
  })

  it('portals dropdown menu and submenu into the popout document body', () => {
    renderInPopout(
      <DropdownMenu open>
        <DropdownMenuTrigger>trigger</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Item 1</DropdownMenuItem>
          <DropdownMenuSub open>
            <DropdownMenuSubTrigger>Sub Trigger</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>Sub Item 1</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
    )
    expect(popoutBody.querySelector('[data-slot="dropdown-menu-content"]')).not.toBeNull()
    expect(popoutBody.querySelector('[data-slot="dropdown-menu-sub-content"]')).not.toBeNull()
    expect(document.body.querySelector('[data-slot="dropdown-menu-sub-content"]')).toBeNull()
  })
})
