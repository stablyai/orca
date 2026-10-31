// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent
} from './context-menu'

afterEach(cleanup)

it.each([undefined, 'default', 'none'] as const)(
  'keeps root and portalled submenu animation=%s exclusive without changing selection',
  async (animation) => {
    const selected = vi.fn()
    const closed = vi.fn()
    render(
      <ContextMenu>
        <ContextMenuTrigger>Open menu</ContextMenuTrigger>
        <ContextMenuContent
          animation={animation}
          className="min-w-[13rem]"
          style={{ opacity: 0.9 }}
          onCloseAutoFocus={closed}
        >
          <ContextMenuSub>
            <ContextMenuSubTrigger>More</ContextMenuSubTrigger>
            <ContextMenuSubContent animation={animation} className="min-w-[12rem]">
              <ContextMenuItem onSelect={selected}>Choose</ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
        </ContextMenuContent>
      </ContextMenu>
    )
    fireEvent.contextMenu(screen.getByText('Open menu'), { clientX: 40, clientY: 20 })
    const root = await screen.findByRole('menu')
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'More' }), { key: 'ArrowRight' })
    const item = await screen.findByRole('menuitem', { name: 'Choose' })
    const submenu = item.closest('[data-slot="context-menu-sub-content"]')
    for (const content of [root, submenu]) {
      expect(content?.getAttribute('animation')).toBeNull()
      if (animation === 'none') {
        expect(content?.className).not.toMatch(/animate-|fade-|zoom-|slide-|duration-/)
        expect(content?.className).toContain('data-[state=closed]:pointer-events-none')
      } else {
        expect(content?.className).toContain('data-[state=open]:animate-in')
        expect(content?.className).toContain('data-[state=closed]:animate-out')
        expect(content?.className).toContain('data-[side=left]:slide-in-from-right-2')
        expect(content?.className).not.toContain('data-[state=closed]:pointer-events-none')
      }
    }
    expect(root.className).toContain('min-w-[13rem]')
    expect(root.style.opacity).toBe('0.9')
    expect(submenu?.className).toContain('min-w-[12rem]')
    expect(root.contains(item)).toBe(false)
    fireEvent.keyDown(item, { key: 'Enter' })
    expect(selected).toHaveBeenCalledOnce()
    await waitFor(() => expect(closed).toHaveBeenCalledOnce())
    expect(screen.queryByRole('menu')).toBeNull()
  }
)
