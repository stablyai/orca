// @vitest-environment happy-dom
import { act } from 'react'
import { fireEvent, getByRole, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AgentLaunchSetupButton } from './AgentLaunchSetupButton'
import { AgentLaunchPickerMenu } from './AgentLaunchPickerMenu'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'
import { clearNativeChatComposerDraftsForTests } from '../native-chat/native-chat-composer-draft-store'
import {
  entry,
  pickerResizeObservers as observers,
  pickerMovementObservers as movements,
  ResizeObserverFixture,
  IntersectionObserverFixture
} from './agent-launch-picker-menu-test-fixture'

vi.mock('@/hooks/useShortcutLabel', () => ({ useOptionalShortcutLabel: () => null }))
let root: Root
let host: HTMLDivElement
let owner = 0
const launch = vi.fn()
beforeEach(() => {
  clearNativeChatComposerDraftsForTests()
  entry.ownerKey = `menu-geometry-${owner++}`
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  launch.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it.each([
  { menuLeft: 700, menuWidth: 280, viewport: 1000, height: 800, side: 'left' },
  { menuLeft: 20, menuWidth: 280, viewport: 1000, height: 800, side: 'right' },
  { menuLeft: 300, menuWidth: 288, viewport: 700, height: 800, side: 'bottom' },
  { menuLeft: 156, menuWidth: 288, viewport: 600, height: 800, side: 'bottom' },
  { menuLeft: 156, menuWidth: 288, viewport: 600, height: 600, side: 'bottom' },
  { menuLeft: 100, menuWidth: 446, viewport: 1600, height: 900, side: 'right', native: true },
  { menuLeft: 1100, menuWidth: 446, viewport: 1600, height: 900, side: 'left', native: true },
  { menuLeft: 278, menuWidth: 446, viewport: 1000, height: 700, native: true },
  { menuLeft: 77, menuWidth: 446, viewport: 600, height: 400, native: true },
  { menuLeft: 278, menuWidth: 446, viewport: 1000, height: 700, native: true, searched: true },
  { menuLeft: 172, menuWidth: 256, viewport: 600, height: 400, native: true, select: true },
  { menuLeft: 13, menuWidth: 266, viewport: 600, height: 400, native: true }
])(
  'contains 416px setup in a $viewport viewport at x=$menuLeft (native=$native searched=$searched select=$select)',
  async ({
    menuLeft,
    menuWidth,
    viewport,
    height,
    side,
    native = false,
    searched = false,
    select = false
  }) => {
    const footer = vi.fn()
    const hydrated: AgentPickerEntry = {
      ...entry,
      arguments: '--add-dir docs',
      terminal: { model: 'astra', permissionMode: 'ask' },
      structured: { model: 'astra', permissionMode: 'ask' }
    }
    const showPopover = (value: AgentPickerEntry) =>
      act(() =>
        root.render(
          <TooltipProvider>
            <DropdownMenu defaultOpen modal={false}>
              <DropdownMenuTrigger>New tab</DropdownMenuTrigger>
              <DropdownMenuContent>
                {native ? (
                  <AgentLaunchPickerMenu
                    entries={[value]}
                    runLaunch={launch}
                    mode={select ? 'select' : 'launch'}
                  />
                ) : (
                  <AgentLaunchSetupButton
                    entry={value}
                    onUse={launch}
                    renderAnchor={(trigger) => <DropdownMenuItem>{trigger}</DropdownMenuItem>}
                  />
                )}
                <DropdownMenuItem onSelect={footer}>Agents footer control</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </TooltipProvider>
        )
      )
    showPopover(hydrated)
    let viewportWidth = viewport
    let placementReads = 0
    observers.clear()
    movements.clear()
    vi.stubGlobal('ResizeObserver', ResizeObserverFixture)
    vi.stubGlobal('IntersectionObserver', IntersectionObserverFixture)
    const contentSelector = native
      ? '[data-slot="dropdown-menu-sub-content"]'
      : '[data-slot="popover-content"]'
    // Supply missing browser layout only; the real Popover/Popper computes collision and placement.
    const menu = new DOMRect(menuLeft, 80, menuWidth, 240)
    const row = new DOMRect(menuLeft + 5, 128, menuWidth - 10, 32)
    const trigger = new DOMRect(menuLeft + menuWidth - 32, 132, 24, 24)
    const panel = new DOMRect(0, 0, 416, 480)
    function geometry(element: Element): DOMRect {
      if (
        element.matches(contentSelector) ||
        (element.hasAttribute('data-radix-popper-content-wrapper') &&
          element.querySelector(contentSelector))
      ) {
        const content = element.matches(contentSelector)
          ? element
          : element.querySelector(contentSelector)!
        const wrapper = content.parentElement!
        const available = Number.parseFloat(
          wrapper.style.getPropertyValue('--radix-popper-available-width')
        )
        const capped = content.classList.contains(
          native
            ? 'max-w-(--radix-dropdown-menu-content-available-width)'
            : 'max-w-(--radix-popover-content-available-width)'
        )
        const minimum = content.classList.contains('min-w-64') ? 256 : 0
        const availableHeight = Number.parseFloat(
          wrapper.style.getPropertyValue('--radix-popper-available-height')
        )
        const cappedHeight = content.classList.contains(
          native
            ? 'max-h-(--radix-dropdown-menu-content-available-height)'
            : 'max-h-(--radix-popover-content-available-height)'
        )
        const translation = wrapper.style.transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\)/)
        return new DOMRect(
          Number(translation?.[1] ?? 0),
          Number(translation?.[2] ?? 0),
          Math.max(
            minimum,
            Math.min(
              content.classList.contains('w-104') ? 416 : panel.width,
              content.classList.contains('max-w-[calc(100vw-1rem)]')
                ? viewportWidth - 16
                : capped && Number.isFinite(available)
                  ? available
                  : panel.width
            )
          ),
          Math.min(
            panel.height,
            cappedHeight && Number.isFinite(availableHeight) ? availableHeight : panel.height
          )
        )
      }
      if (element.matches('[role="menuitem"]')) {
        return element.isConnected ? DOMRect.fromRect(row) : new DOMRect()
      }
      if (element.matches('[data-slot="popover-trigger"]')) {
        return element.isConnected ? DOMRect.fromRect(trigger) : new DOMRect()
      }
      if (
        element.matches('[role="menu"]') ||
        element.hasAttribute('data-radix-popper-content-wrapper')
      ) {
        return DOMRect.fromRect(menu)
      }
      if (element === document.documentElement || element === document.body) {
        return new DOMRect(0, 0, viewportWidth, height)
      }
      return new DOMRect()
    }
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      return geometry(this)
    })
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
      this: HTMLElement
    ) {
      return geometry(this).width
    })
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
      this: HTMLElement
    ) {
      return geometry(this).height
    })
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockImplementation(() => viewportWidth)
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(height)
    const computeStyle = window.getComputedStyle.bind(window)
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
      const style = computeStyle(element, pseudo)
      if (!element.matches(contentSelector)) {
        return style
      }
      // happy-dom has no Tailwind layout; resolve only the consumer's sizing rules and CSS alias.
      const isStyleProperty = (key: PropertyKey): key is keyof CSSStyleDeclaration => key in style
      return new Proxy(style, {
        get(target, property) {
          if (property === 'minWidth' && element.classList.contains('min-w-64')) {
            return '256px'
          }
          if (property === 'getPropertyValue') {
            return (name: string) => {
              if (name === '--radix-popover-content-available-width') {
                placementReads++
                return element.parentElement!.style.getPropertyValue(
                  '--radix-popper-available-width'
                )
              }
              return target.getPropertyValue(name)
            }
          }
          if (!isStyleProperty(property)) {
            return undefined
          }
          const value = target[property]
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
    })
    if (searched) {
      fireEvent.change(getByRole(document.body, 'textbox', { name: '' }), {
        target: { value: 'Astra' }
      })
    }
    const configure = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Configure Codex"]'
    )!
    const nativeRow = configure.closest<HTMLElement>('[role="menuitem"]')!
    const user = userEvent.setup()
    await user.click(configure)
    const content = document.querySelector<HTMLElement>(contentSelector)!
    expect(content.classList.contains('w-104')).toBe(true)
    await waitFor(() => {
      if (side) {
        expect(content.dataset.side).toBe(side)
      }
      const transform = content.parentElement!.style.transform.match(
        /translate\(([-\d.]+)px, ([-\d.]+)px\)/
      )
      expect(transform).not.toBeNull()
      const x = Number(transform![1])
      const y = Number(transform![2])
      expect(x).toBeGreaterThanOrEqual(0)
      const width = content.offsetWidth
      expect(x + width).toBeLessThanOrEqual(viewport)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y + content.offsetHeight).toBeLessThanOrEqual(height)
      if (side === 'left') {
        if (native) {
          expect(row.left - x - width).toBe(4)
        } else {
          expect(x + width).toBeLessThanOrEqual(menu.left)
        }
      } else if (side === 'right') {
        if (native) {
          expect(x - row.right).toBe(4)
        } else {
          expect(x).toBeGreaterThanOrEqual(menu.right)
        }
      } else if (side === 'bottom') {
        expect(y).toBeGreaterThanOrEqual(row.bottom)
      }
      expect(width).toBe(416)
      if (native) {
        expect(['left', 'right']).toContain(content.dataset.side)
        expect(x).toBeGreaterThanOrEqual(8)
        expect(x + width).toBeLessThanOrEqual(viewport - 8)
      }
    })
    if (native) {
      const rect = content.getBoundingClientRect()
      const left = content.dataset.side === 'left'
      const exit = left ? row.left + 1 : row.right - 1
      fireEvent.pointerMove(nativeRow, {
        pointerType: 'mouse',
        clientX: left ? exit + 10 : exit - 10,
        clientY: row.y + 12
      })
      fireEvent.pointerOut(nativeRow, {
        pointerType: 'mouse',
        clientX: exit,
        clientY: row.y + 12,
        relatedTarget: content
      })
      fireEvent.pointerMove(content, {
        pointerType: 'mouse',
        clientX: left ? rect.right - 12 : rect.left + 12,
        clientY: rect.y + 12
      })
      expect(document.querySelector(contentSelector)).toBe(content)
      expect(launch).not.toHaveBeenCalled()
    }
    if (!native) {
      await waitFor(() => expect(placementReads).toBe(1))
    }
    const originalTransform = content.parentElement!.style.transform
    fireEvent.click(content.querySelector('button[aria-label="Toggle Arguments"]')!)
    fireEvent.change(content.querySelector('textarea')!, { target: { value: '--add-dir src' } })
    fireEvent.keyDown(content.querySelector('button[aria-label="Codex permissions"]')!, {
      key: 'ArrowDown'
    })
    fireEvent.click(
      [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) =>
        item.textContent?.startsWith('Full access')
      )!
    )
    expect(content.querySelector('button[aria-label="Codex permissions"]')?.textContent).toContain(
      'Full access'
    )
    showPopover({ ...hydrated })
    expect(document.querySelector('[role="menuitem"]')?.isConnected).toBe(true)
    await waitFor(() => {
      expect(content.parentElement!.style.transform).toBe(originalTransform)
      expect(content.parentElement!.style.getPropertyValue('--radix-popper-anchor-width')).toBe(
        `${row.width}px`
      )
      expect(content.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('--add-dir src')
    })
    if (!native) {
      expect(placementReads).toBe(1)
    }
    if (viewport <= 1000) {
      process.stdout.write(
        `${JSON.stringify({ metric: 'picker-contained-layout', native, searched, select, viewport, height, menuLeft, side: content.dataset.side, transform: content.parentElement!.style.transform, width: content.offsetWidth, contentHeight: content.offsetHeight, availableWidth: content.parentElement!.style.getPropertyValue('--radix-popper-available-width'), placementReads })}\n`
      )
    }
    function externalResize(width: number, menuX = menu.x) {
      act(() => {
        viewportWidth = width
        menu.x = menuX
        row.x = menuX + 5
        trigger.x = menuX + menuWidth - 32
        fireEvent(window, new Event('resize'))
        for (const observer of observers) {
          if (
            [...observer.targets].some(
              (target) => target === document.documentElement || target.matches('[role="menuitem"]')
            )
          ) {
            observer.callback([], observer)
          }
        }
      })
    }
    if (native) {
      const search = content.querySelector<HTMLInputElement>('[cmdk-input]')!
      expect(content.querySelector('.overflow-y-auto')).not.toBeNull()
      expect(
        getByRole(content, 'button', { name: 'Launch terminal' }).hasAttribute('disabled')
      ).toBe(false)
      for (const width of [600, 1600, viewport]) {
        externalResize(width, width === 600 ? 77 : menuLeft)
        try {
          await waitFor(() => {
            expect(document.querySelector(contentSelector)).toBe(content)
            const rect = content.getBoundingClientRect()
            expect(rect.width).toBe(416)
            expect(rect.left).toBeGreaterThanOrEqual(8)
            expect(rect.right).toBeLessThanOrEqual(width - 8)
            expect(content.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(
              '--add-dir src'
            )
            expect(
              content.querySelector('button[aria-label="Codex permissions"]')?.textContent
            ).toContain('Full access')
          })
        } catch (error) {
          process.stdout.write(
            `${JSON.stringify({ metric: 'native-resize-failure', input: { viewport, height, menuLeft, menuWidth, searched, select }, resizedViewport: width, anchor: row.toJSON(), side: content.dataset.side, rect: content.getBoundingClientRect().toJSON(), transform: content.parentElement!.style.transform, availableWidth: content.parentElement!.style.getPropertyValue('--radix-popper-available-width'), arguments: content.querySelector<HTMLTextAreaElement>('textarea')?.value, sameContent: document.querySelector(contentSelector) === content })}\n`
          )
          throw error
        }
      }
      // A same-size anchor can move when its root is repositioned.
      const previousAnchor = row.x
      act(() => {
        menu.x = viewportWidth - menuWidth - 13
        row.x = menu.x + 5
        trigger.x = menu.x + menuWidth - 32
        for (const observer of new Set(movements)) {
          for (const target of observer.targets) {
            const rect = target.getBoundingClientRect()
            observer.callback(
              [
                {
                  target,
                  time: 0,
                  boundingClientRect: rect,
                  intersectionRect: rect,
                  rootBounds: new DOMRect(0, 0, viewportWidth, height),
                  intersectionRatio: 1,
                  isIntersecting: true
                }
              ],
              observer
            )
          }
        }
      })
      await waitFor(() => {
        const rect = content.getBoundingClientRect()
        expect(rect.width).toBe(416)
        expect(rect.left).toBeGreaterThanOrEqual(8)
        expect(rect.right).toBeLessThanOrEqual(viewportWidth - 8)
        expect(row.x).not.toBe(previousAnchor)
        expect(content.dataset.side).toBe('left')
        expect(rect.right).toBe(row.left - Math.min(4, row.left - 8 - 416))
      })
      const movedTransform = content.parentElement!.style.transform
      act(() => {
        menu.x = 13
        row.x = 18
        trigger.x = menu.x + menuWidth - 32
        for (const observer of new Set(movements)) {
          for (const target of observer.targets) {
            const rect = target.getBoundingClientRect()
            observer.callback(
              [
                {
                  target,
                  time: 0,
                  boundingClientRect: rect,
                  intersectionRect: rect,
                  rootBounds: new DOMRect(0, 0, viewportWidth, height),
                  intersectionRatio: 1,
                  isIntersecting: true
                }
              ],
              observer
            )
          }
        }
      })
      await waitFor(() => {
        const rect = content.getBoundingClientRect()
        expect(content.dataset.side).toBe('right')
        expect(rect.left).toBe(row.right + Math.min(4, viewportWidth - row.right - 8 - 416))
        expect(rect.width).toBe(416)
        expect(content.parentElement!.style.transform).not.toBe(movedTransform)
        expect(document.querySelector(contentSelector)).toBe(content)
        expect(content.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('--add-dir src')
      })
      const rect = content.getBoundingClientRect()
      fireEvent.pointerMove(nativeRow, {
        pointerType: 'mouse',
        clientX: row.right - 2,
        clientY: row.y + 12
      })
      fireEvent.pointerOut(nativeRow, {
        pointerType: 'mouse',
        clientX: row.right - 1,
        clientY: row.y + 12,
        relatedTarget: content
      })
      fireEvent.pointerMove(content, {
        pointerType: 'mouse',
        clientX: rect.left + 12,
        clientY: rect.y + 12
      })
      expect(document.querySelector(contentSelector)).toBe(content)
      expect(launch).not.toHaveBeenCalled()
      search.focus()
      await user.type(search, 'a')
      await user.keyboard('{ArrowLeft}')
      expect(document.activeElement).toBe(search)
      expect(document.querySelector(contentSelector)).toBe(content)
      await user.clear(search)
      fireEvent.keyDown(search, { key: 'ArrowLeft', isComposing: true })
      expect(document.querySelector(contentSelector)).toBe(content)
      await user.keyboard('{ArrowLeft}')
      expect(document.querySelector(contentSelector)).toBeNull()
      expect(document.activeElement).toBe(nativeRow)
      await user.keyboard('{ArrowRight}')
      expect(document.activeElement).toBe(document.querySelector('[cmdk-input]'))
      await user.keyboard('{Escape}')
      expect(document.activeElement).toBe(configure)
      expect(document.querySelector(contentSelector)).toBeNull()
      await user.pointer([
        { target: nativeRow.querySelector('span')!, keys: '[MouseLeft>]' },
        { target: configure, keys: '[/MouseLeft]' }
      ])
      expect(launch).not.toHaveBeenCalled()
      if (document.querySelector(contentSelector)) {
        await user.click(configure)
        await user.keyboard('{Escape}')
      }
      await user.click(getByRole(document.body, 'menuitem', { name: 'Agents footer control' }))
      expect(footer).toHaveBeenCalledOnce()
      expect(launch).not.toHaveBeenCalled()
    }
    if (!native && (viewport === 700 || (viewport === 600 && height === 800))) {
      externalResize(600, 156)
      await waitFor(() => {
        expect(placementReads).toBe(2)
        expect(content.dataset.side).toBe('bottom')
        const position = content.parentElement!.style.transform.match(/translate\(([-\d.]+)px,/)
        expect(position).not.toBeNull()
        expect(Number(position![1])).toBeGreaterThanOrEqual(0)
        expect(Number(position![1]) + content.offsetWidth).toBeLessThanOrEqual(viewportWidth)
      })
      externalResize(1000)
      await waitFor(() => {
        expect(placementReads).toBe(3)
        expect(content.dataset.side).toBe('right')
      })
      // A panel's own resize must not restart the placement decision.
      act(() => {
        for (const observer of observers) {
          if (observer.targets.has(content) || observer.targets.has(content.parentElement!)) {
            observer.callback([], observer)
          }
        }
      })
      await waitFor(() => {
        expect(placementReads).toBe(3)
        expect(content.dataset.side).toBe('right')
      })
      fireEvent.keyDown(content, { key: 'Escape' })
      expect(document.querySelector('[data-slot="popover-content"]')).toBeNull()
      expect(
        [...observers].some((observer) => observer.targets.has(document.documentElement))
      ).toBe(false)
      fireEvent.click(document.querySelector('button[aria-label="Configure Codex"]')!)
      await waitFor(() =>
        expect(
          document.querySelector<HTMLElement>('[data-slot="popover-content"]')?.dataset.side
        ).toBe('right')
      )
      await waitFor(() => expect(placementReads).toBe(4))
    }
    expect(launch).not.toHaveBeenCalled()
  }
)
