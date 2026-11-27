// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { TooltipProvider } from '@/components/ui/tooltip'
import { PermissionChoiceRadioItem } from './PermissionChoiceRadioItem'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const DESCRIPTION = 'Reviews approval requests for you'

type OpenWith = 'keyboard' | 'mouse' | 'touch'

function renderMenu({
  onSelect = vi.fn(),
  disabled = false,
  openWith = 'keyboard'
}: { onSelect?: () => void; disabled?: boolean; openWith?: OpenWith } = {}) {
  render(
    <TooltipProvider>
      <DropdownMenu>
        <DropdownMenuTrigger>Permissions</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuRadioGroup value="">
            <PermissionChoiceRadioItem
              value="auto"
              description={DESCRIPTION}
              disabled={disabled}
              onSelect={onSelect}
            >
              Approve for me
            </PermissionChoiceRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  )
  const trigger = screen.getByRole('button', { name: 'Permissions' })
  if (openWith === 'keyboard') {
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  } else {
    fireEvent.pointerDown(trigger, { pointerType: openWith, button: 0 })
    fireEvent.pointerUp(trigger, { pointerType: openWith, button: 0 })
  }
  return onSelect
}

const row = () => screen.getByRole('menuitemradio', { name: 'Approve for me' })

/** The inline description line (the copy shown on screen, not the accessible one). */
const inlineDescription = () =>
  [...row().querySelectorAll<HTMLElement>('[aria-hidden]')].find(
    (node) => node.textContent === DESCRIPTION
  )

/**
 * happy-dom applies no CSS, so every element reports a box. On a wide hover screen the inline line
 * is `display: none` until a tap reveals it; model that from its responsive `:hidden` class.
 */
function hideInlineDescriptionsLikeAWideHoverScreen(): void {
  const rects = vi.fn(function (this: Element): DOMRectList {
    const hidden = String(this.getAttribute('class')).includes(':hidden')
    const list = hidden ? [] : [new DOMRect(0, 0, 10, 10)]
    return Object.assign(list, { item: (index: number) => list[index] ?? null })
  })
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(rects)
}

/** A tap's events as Chromium sends them, including the mouse events it emulates. */
function tap(element: HTMLElement): void {
  fireEvent.pointerDown(element, { pointerType: 'touch', button: 0 })
  fireEvent.pointerUp(element, { pointerType: 'touch', button: 0 })
  fireEvent.mouseDown(element, { button: 0 })
  fireEvent.mouseUp(element, { button: 0 })
  fireEvent.click(element)
}

it('describes the row with its own hidden description, with or without the tooltip', async () => {
  renderMenu({ openWith: 'mouse' })
  const item = await screen.findByRole('menuitemradio', { name: 'Approve for me' })
  const describedBy = () => document.getElementById(item.getAttribute('aria-describedby') ?? '')
  // Why closed first: an open Radix tooltip describes its trigger on its own.
  expect(screen.queryByRole('tooltip')).toBeNull()
  expect(describedBy()?.hidden).toBe(true)
  expect(item.contains(describedBy())).toBe(true)
  expect(describedBy()?.textContent).toBe(DESCRIPTION)

  fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' })
  await screen.findByRole('tooltip')
  expect(describedBy()?.hidden).toBe(true)
  expect(item.contains(describedBy())).toBe(true)
})

it('keeps a disabled row focusable but never selects it', async () => {
  const onSelect = renderMenu({ disabled: true })
  const item = await screen.findByRole('menuitemradio', { name: 'Approve for me' })
  expect(item.getAttribute('aria-disabled')).toBe('true')
  expect(item.hasAttribute('data-disabled')).toBe(false)
  fireEvent.keyDown(item, { key: 'Enter' })
  expect(onSelect).not.toHaveBeenCalled()
  expect(screen.queryByRole('menu')).not.toBeNull()
})

it('closes the menu with one Escape while the tooltip is open', async () => {
  renderMenu()
  const item = await screen.findByRole('menuitemradio', { name: 'Approve for me' })
  item.focus()
  await screen.findByRole('tooltip')
  fireEvent.keyDown(document.activeElement ?? document, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
})

it('keeps focus in the menu when the tooltip is clicked', async () => {
  renderMenu()
  await screen.findByRole('menuitemradio', { name: 'Approve for me' })
  const tooltip = await screen.findByRole('tooltip')
  // Why the return value: happy-dom never moves focus on mousedown; a browser does unless prevented.
  expect(fireEvent.mouseDown(tooltip)).toBe(false)
  expect(screen.queryByRole('menu')).not.toBeNull()
})

it('shows descriptions inline, without a tooltip, in a menu opened by touch', async () => {
  hideInlineDescriptionsLikeAWideHoverScreen()
  renderMenu({ openWith: 'touch' })
  await screen.findByRole('menuitemradio', { name: 'Approve for me' })
  expect(inlineDescription()?.getClientRects()).toHaveLength(1)
  row().focus()
  expect(screen.queryByRole('tooltip')).toBeNull()
})

it('reveals a hidden description on the first tap and selects on the second', async () => {
  hideInlineDescriptionsLikeAWideHoverScreen()
  const onSelect = renderMenu({ openWith: 'mouse' })
  await screen.findByRole('menuitemradio', { name: 'Approve for me' })
  expect(inlineDescription()?.getClientRects()).toHaveLength(0)

  tap(row())
  expect(onSelect).not.toHaveBeenCalled()
  expect(screen.queryByRole('menu')).not.toBeNull()
  expect(inlineDescription()?.getClientRects()).toHaveLength(1)

  tap(row())
  expect(onSelect).toHaveBeenCalledTimes(1)
})

it('selects from the keyboard after a tap, even while the description is hidden', async () => {
  hideInlineDescriptionsLikeAWideHoverScreen()
  const onSelect = renderMenu({ openWith: 'mouse' })
  await screen.findByRole('menuitemradio', { name: 'Approve for me' })
  fireEvent.pointerDown(row(), { pointerType: 'touch', button: 0 })
  fireEvent.pointerUp(row(), { pointerType: 'touch', button: 0 })
  expect(inlineDescription()?.getClientRects()).toHaveLength(0)
  fireEvent.keyDown(row(), { key: 'Enter' })
  expect(onSelect).toHaveBeenCalledTimes(1)
})

it('still closes the tooltip after focus left a row while its tooltip was closed', async () => {
  renderMenu({ openWith: 'mouse' })
  const item = await screen.findByRole('menuitemradio', { name: 'Approve for me' })
  const menu = screen.getByRole('menu')
  expect(screen.queryByRole('tooltip')).toBeNull()
  // The pointer crossed the row before its tooltip opened: focus moves back to the menu.
  fireEvent.focusOut(item, { relatedTarget: menu })
  await Promise.resolve()

  fireEvent.keyDown(menu, { key: 'ArrowDown' })
  item.focus()
  await screen.findByRole('tooltip')
  // Scrolling the menu closes the tooltip; the earlier blur must not swallow that close.
  fireEvent.scroll(menu)
  await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
})
