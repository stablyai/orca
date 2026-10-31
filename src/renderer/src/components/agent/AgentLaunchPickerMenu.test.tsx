// @vitest-environment happy-dom
import { act } from 'react'
import { fireEvent, getByRole, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AgentLaunchSetupButton } from './AgentLaunchSetupButton'
import { AgentLaunchPickerMenu } from './AgentLaunchPickerMenu'
import {
  agentPickerChoiceSeeds,
  agentPickerLaunchInputs,
  type AgentPickerEntry
} from '../../../../shared/agent-launch-picker'

vi.mock('@/hooks/useShortcutLabel', () => ({ useOptionalShortcutLabel: () => null }))
const entry: AgentPickerEntry = {
  agent: 'codex',
  label: 'Codex',
  rows: [{ agent: 'codex', kind: 'chat' }],
  surfaces: ['chat', 'terminal'],
  defaultSurface: 'chat',
  terminal: {},
  structured: {},
  catalog: {
    origin: 'probe',
    fetchedAt: 1,
    models: [
      { id: 'astra', label: 'Astra', isDefault: true, efforts: [{ value: 'low', label: 'Low' }] }
    ]
  }
}
let root: Root
let host: HTMLDivElement
let owner = 0
const launch = vi.fn()
function show(value: AgentPickerEntry, others: AgentPickerEntry[] = []) {
  const entries = [value, ...others]
  act(() =>
    root.render(
      <TooltipProvider>
        <DropdownMenu defaultOpen modal={false}>
          <DropdownMenuTrigger>New tab</DropdownMenuTrigger>
          <DropdownMenuContent>
            <AgentLaunchPickerMenu entries={entries} runLaunch={launch} />
          </DropdownMenuContent>
        </DropdownMenu>
      </TooltipProvider>
    )
  )
}
beforeEach(() => {
  entry.ownerKey = `menu-test-${owner++}`
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  launch.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  show(entry)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it.each(['chat', 'terminal'] as const)(
  'keeps preferred %s defaults and sparse primary/Enter intent after alternate launch and reopen',
  async (preferred) => {
    const own: AgentPickerEntry = {
      ...entry,
      agent: 'claude',
      label: 'Claude',
      ownerKey: `${entry.ownerKey}/preferred-${preferred}`,
      defaultSurface: preferred,
      arguments: '',
      terminal: { permissionMode: 'full-access' },
      structured: { model: 'sonnet', options: { effort: 'high' }, permissionMode: 'ask' },
      catalog: {
        origin: 'probe',
        fetchedAt: 1,
        listingNamesConfiguredModel: true,
        models: ['opus', 'sonnet'].map((id) => ({
          id,
          label: id,
          isDefault: id === 'opus',
          defaultEffort: id === 'opus' ? 'low' : 'high',
          efforts: [
            { value: 'low', label: 'Low' },
            { value: 'high', label: 'High' }
          ]
        }))
      }
    }
    act(() =>
      root.render(
        <TooltipProvider>
          <AgentLaunchSetupButton entry={own} onUse={launch} />
        </TooltipProvider>
      )
    )
    const user = userEvent.setup()
    const open = () => user.click(getByRole(document.body, 'button', { name: 'Configure Claude' }))
    const expectDefaults = () => {
      expect(document.querySelector('[cmdk-item][data-current="true"]')?.textContent).toBe(
        preferred === 'chat' ? 'sonnet' : 'opus'
      )
      expect(
        getByRole(document.body, 'radio', {
          name: preferred === 'chat' ? 'High' : 'Low'
        }).getAttribute('data-state')
      ).toBe('on')
      expect(getByRole(document.body, 'button', { name: 'Claude permissions' }).textContent).toBe(
        preferred === 'chat' ? 'Ask for approval' : 'Full access'
      )
    }
    const expectSparse = (surface: 'chat' | 'terminal') => {
      const draft = launch.mock.lastCall![0]
      expect(draft).toEqual({ agent: 'claude', surface, choices: {}, arguments: undefined })
      expect(agentPickerLaunchInputs(draft, own)).toEqual({})
    }
    await open()
    expectDefaults()
    const alternate = preferred === 'chat' ? 'terminal' : 'chat'
    await user.click(getByRole(document.body, 'button', { name: `Launch ${alternate}` }))
    expectSparse(alternate)
    for (const method of ['primary', 'Enter']) {
      await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
      await open()
      expectDefaults()
      if (method === 'primary') {
        await user.click(getByRole(document.body, 'button', { name: `Launch ${preferred}` }))
      } else {
        if (!document.querySelector('textarea')) {
          await user.click(getByRole(document.body, 'button', { name: 'Toggle Arguments' }))
        }
        await user.click(document.querySelector<HTMLTextAreaElement>('textarea')!)
        await user.keyboard('{Enter}')
      }
      expectSparse(preferred)
    }
    expect(launch).toHaveBeenCalledTimes(3)
  }
)

it.each([
  { menuLeft: 700, menuWidth: 280, viewport: 1000, height: 800, side: 'left' },
  { menuLeft: 20, menuWidth: 280, viewport: 1000, height: 800, side: 'right' },
  { menuLeft: 300, menuWidth: 288, viewport: 700, height: 800, side: 'left' },
  { menuLeft: 156, menuWidth: 288, viewport: 600, height: 800, side: 'bottom' },
  { menuLeft: 156, menuWidth: 288, viewport: 600, height: 600, side: 'bottom' }
])(
  'contains setup in a $viewport viewport at x=$menuLeft, preferring $side',
  async ({ menuLeft, menuWidth, viewport, height, side }) => {
    const hydrated: AgentPickerEntry = {
      ...entry,
      arguments: '--add-dir docs',
      terminal: { model: 'astra', permissionMode: 'ask' },
      structured: { model: 'astra', permissionMode: 'ask' }
    }
    show(hydrated)
    let viewportWidth = viewport
    let placementReads = 0
    const observers = new Set<ResizeObserverFixture>()
    class ResizeObserverFixture implements ResizeObserver {
      targets = new Set<Element>()
      constructor(readonly callback: ResizeObserverCallback) {
        observers.add(this)
      }
      observe(target: Element) {
        this.targets.add(target)
      }
      unobserve(target: Element) {
        this.targets.delete(target)
      }
      disconnect() {
        this.targets.clear()
        observers.delete(this)
      }
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverFixture)
    // Supply missing browser layout only; the real Popover/Popper computes collision and placement.
    const menu = new DOMRect(menuLeft, 80, menuWidth, 240)
    const row = new DOMRect(menuLeft + 5, 128, menuWidth - 10, 32)
    const trigger = new DOMRect(menuLeft + menuWidth - 32, 132, 24, 24)
    const panel = new DOMRect(0, 0, 416, 480)
    function geometry(element: Element): DOMRect {
      if (
        element.matches('[data-slot="popover-content"]') ||
        (element.hasAttribute('data-radix-popper-content-wrapper') &&
          element.querySelector('[data-slot="popover-content"]'))
      ) {
        const content = element.matches('[data-slot="popover-content"]')
          ? element
          : element.querySelector('[data-slot="popover-content"]')!
        const wrapper = content.parentElement!
        const available = Number.parseFloat(
          wrapper.style.getPropertyValue('--radix-popper-available-width')
        )
        const capped = content.classList.contains('max-w-(--radix-popover-content-available-width)')
        const minimum = content.classList.contains('min-w-64') ? 256 : 0
        const availableHeight = Number.parseFloat(
          wrapper.style.getPropertyValue('--radix-popper-available-height')
        )
        const cappedHeight = content.classList.contains(
          'max-h-(--radix-popover-content-available-height)'
        )
        return new DOMRect(
          0,
          0,
          Math.max(
            minimum,
            Math.min(panel.width, capped && Number.isFinite(available) ? available : panel.width)
          ),
          Math.min(
            panel.height,
            cappedHeight && Number.isFinite(availableHeight) ? availableHeight : panel.height
          )
        )
      }
      if (element.matches('[role="menuitem"]')) {
        return element.isConnected ? row : new DOMRect()
      }
      if (element.matches('[data-slot="popover-trigger"]')) {
        return element.isConnected ? trigger : new DOMRect()
      }
      if (
        element.matches('[role="menu"]') ||
        element.hasAttribute('data-radix-popper-content-wrapper')
      ) {
        return menu
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
      if (!element.matches('[data-slot="popover-content"]')) {
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
    act(() =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Configure Codex"]')!.click()
    )
    const content = document.querySelector<HTMLElement>('[data-slot="popover-content"]')!
    expect(content.classList.contains('w-104')).toBe(true)
    await waitFor(() => {
      expect(content.dataset.side).toBe(side)
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
        expect(x + width).toBeLessThanOrEqual(menu.left)
      } else if (side === 'right') {
        expect(x).toBeGreaterThanOrEqual(menu.right)
      } else {
        expect(y).toBeGreaterThanOrEqual(row.bottom)
      }
      if (viewport === 700) {
        expect(width).toBe(299)
      }
      if (viewport === 600) {
        expect(width).toBe(panel.width)
      }
    })
    await waitFor(() => expect(placementReads).toBe(1))
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
    show({ ...hydrated })
    expect(document.querySelector('[role="menuitem"]')?.isConnected).toBe(true)
    await waitFor(() => {
      expect(content.parentElement!.style.transform).toBe(originalTransform)
      expect(content.parentElement!.style.getPropertyValue('--radix-popper-anchor-width')).toBe(
        `${row.width}px`
      )
      expect(content.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('--add-dir src')
    })
    expect(placementReads).toBe(1)
    if (viewport <= 700) {
      process.stdout.write(
        `${JSON.stringify({ metric: 'picker-contained-layout', viewport, height, menuLeft, side: content.dataset.side, transform: content.parentElement!.style.transform, width: content.offsetWidth, contentHeight: content.offsetHeight, availableWidth: content.parentElement!.style.getPropertyValue('--radix-popper-available-width'), placementReads })}\n`
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
    if (viewport === 700 || (viewport === 600 && height === 800)) {
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

it('opens setup with a clicked chevron without launching, then dispatches its selected surface once', () => {
  const configure = getByRole(document.body, 'button', { name: 'Configure Codex' })
  expect(configure?.dataset.variant).toBe('ghost')
  expect(configure?.previousElementSibling?.getAttribute('data-orientation')).toBe('vertical')
  act(() => configure?.click())
  expect(launch).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('Arguments')
  expect(getByRole(document.body, 'dialog', { name: 'Configure Codex' })).not.toBeNull()
  const terminal = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === 'Launch terminal'
  )
  act(() => terminal?.click())
  expect(launch).toHaveBeenCalledTimes(1)
  expect(launch.mock.calls[0]).toMatchObject([
    { agent: 'codex', kind: 'cli' },
    { agent: 'codex', surface: 'terminal', choices: {} },
    entry
  ])
})
it('keeps setup open while the pointer expands and collapses Arguments', async () => {
  const user = userEvent.setup()
  await user.click(
    document.querySelector<HTMLButtonElement>('button[aria-label="Configure Codex"]')!
  )
  const panel = document.querySelector('[role="dialog"]')!
  expect(panel).not.toBeNull()
  expect(panel.querySelector('textarea[aria-label="Arguments"]')).toBeNull()
  const toggle = panel.querySelector<HTMLButtonElement>('button[aria-label="Toggle Arguments"]')!
  await user.hover(toggle)
  expect(document.querySelector('[role="dialog"]')).toBe(panel)
  await user.click(toggle)
  expect(document.querySelector('[role="dialog"]')).toBe(panel)
  expect(panel.querySelector('textarea[aria-label="Arguments"]')).not.toBeNull()
  await user.click(toggle)
  expect(document.querySelector('[role="dialog"]')).toBe(panel)
  expect(panel.querySelector('textarea[aria-label="Arguments"]')).toBeNull()
  expect(launch).not.toHaveBeenCalled()
})

it.each(['{Enter}', ' '])(
  'keeps setup on hover, replaces it on keyboard %s, and dismisses without launching',
  async (key) => {
    show(entry, [
      {
        ...entry,
        agent: 'claude',
        label: 'Claude',
        rows: [{ agent: 'claude', kind: 'chat' }]
      }
    ])
    const user = userEvent.setup()
    await user.click(
      document.querySelector<HTMLButtonElement>('button[aria-label="Configure Codex"]')!
    )
    const panel = document.querySelector('[role="dialog"]')!
    expect(panel).not.toBeNull()
    const closeAutoFocus = vi.fn()
    panel.addEventListener('focusScope.autoFocusOnUnmount', closeAutoFocus, { once: true })
    const otherRow = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (row) => row.textContent === 'Claude'
    )!
    fireEvent.pointerMove(otherRow, { pointerType: 'mouse' })
    await waitFor(() => expect(document.activeElement).toBe(otherRow))
    expect(document.querySelector('[role="dialog"]')).toBe(panel)
    await user.keyboard('{ArrowRight}')
    const otherTrigger = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Configure Claude"]'
    )!
    expect(document.activeElement).toBe(otherTrigger)
    await user.keyboard(key)
    await waitFor(() => expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1))
    const replacement = document.querySelector('[role="dialog"]')!
    const search = replacement.querySelector<HTMLInputElement>(
      'input[placeholder="Search Claude models…"]'
    )!
    expect(search).not.toBeNull()
    expect(replacement).not.toBe(panel)
    await waitFor(() => expect(panel.isConnected).toBe(false))
    await waitFor(() => expect(closeAutoFocus).toHaveBeenCalledOnce())
    expect(document.activeElement).toBe(search)
    await user.keyboard('astra')
    expect(search.value).toBe('astra')
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(otherTrigger))
    await user.click(otherTrigger)
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    fireEvent.pointerDown(document.body, { pointerType: 'mouse', button: 0 })
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
    expect(launch).not.toHaveBeenCalled()
  }
)

it('keeps model, permission and Fast badge pointer interactions inside setup, but dismisses outside', async () => {
  show({
    ...entry,
    agent: 'claude',
    label: 'Claude',
    rows: [{ agent: 'claude', kind: 'chat' }],
    ...agentPickerChoiceSeeds('claude', {
      agentPermissionDefault: 'own',
      agentDefaultArgs: {
        claude: `--model opus --settings '{"fastMode":true,"theme":"light"}' --add-dir docs`
      }
    }),
    structured: { model: 'opus', permissionMode: 'own', options: { fastMode: 'true' } },
    catalog: {
      origin: 'probe',
      fetchedAt: 1,
      models: [{ id: 'opus', label: 'Opus', isDefault: true, efforts: [], supportsFastMode: true }]
    }
  })
  const user = userEvent.setup()
  await user.click(
    document.querySelector<HTMLButtonElement>('button[aria-label="Configure Claude"]')!
  )
  const panel = document.querySelector('[role="dialog"]')!
  const model = panel.querySelector<HTMLElement>('[cmdk-item]')!
  await user.hover(model)
  await user.click(model)
  expect(document.querySelector('[role="dialog"]')).toBe(panel)
  await user.click(
    panel.querySelector<HTMLButtonElement>('button[aria-label="Claude permissions"]')!
  )
  await user.click(
    [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) =>
      item.textContent?.startsWith('Full access')
    )!
  )
  expect(document.querySelector('[role="dialog"]')).toBe(panel)
  await user.click(panel.querySelector<HTMLButtonElement>('button[aria-label="Toggle Arguments"]')!)
  const chip = panel.querySelector<HTMLButtonElement>('button[aria-label*="Remove --settings"]')!
  expect(chip).not.toBeNull()
  await user.click(chip)
  expect(document.querySelector('[role="dialog"]')).toBe(panel)
  expect(panel.querySelector('button[aria-label*="Remove --settings"]')).toBeNull()
  expect(panel.querySelector<HTMLTextAreaElement>('textarea')?.value).toContain('"theme":"light"')
  await user.click(document.body)
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(launch).not.toHaveBeenCalled()
})

it('opens a searched setup only from its chevron and launches the alternate way from its footer', () => {
  const input = document.querySelector('input')
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(
      input,
      'astra low'
    )
    input?.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const row = document.querySelector<HTMLElement>('[role="menuitem"]')!
  expect(row.querySelectorAll('button')).toHaveLength(1)
  expect(document.querySelector('button[aria-label="Launch terminal"]')).toBeNull()
  act(() => row.querySelector<HTMLButtonElement>('button')?.click())
  expect(launch).not.toHaveBeenCalled()
  const alternate = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === 'Launch terminal'
  )
  act(() => alternate?.click())
  expect(launch).toHaveBeenCalledTimes(1)
  expect(launch.mock.calls[0][1]).toMatchObject({
    surface: 'terminal',
    choices: { model: 'astra', options: { effort: 'low' } }
  })
  expect(document.querySelector('[role="menu"]')).toBeNull()
})

it('shows only the chevron and keeps a plain row click free of setup overrides', () => {
  const row = document.querySelector<HTMLElement>('[role="menuitem"]')!
  expect(
    [...row.querySelectorAll('button')].map((button) => button.getAttribute('aria-label'))
  ).toEqual(['Configure Codex'])
  act(() => row.click())
  expect(launch).toHaveBeenCalledExactlyOnceWith(entry.rows[0], undefined)
  expect(document.querySelector('[role="menu"]')).toBeNull()
})

it('launches the row default with Enter once, without opening setup', () => {
  const row = document.querySelector<HTMLElement>('[role="menuitem"]')!
  act(() => {
    row.focus()
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  expect(launch).toHaveBeenCalledExactlyOnceWith(entry.rows[0], undefined)
  expect(document.querySelector('input[aria-label="Search models"]')).toBeNull()
  expect(document.querySelector('[role="menu"]')).toBeNull()
})

it('still launches today’s default when the row is clicked while its setup is open', async () => {
  const user = userEvent.setup()
  const row = document.querySelector<HTMLElement>('[role="menuitem"]')!
  await user.click(row.querySelector<HTMLButtonElement>('button')!)
  expect(launch).not.toHaveBeenCalled()
  await user.click(row)
  expect(launch).toHaveBeenCalledExactlyOnceWith(entry.rows[0], undefined)
})

it('lets the chevron return keyboard focus to its row without opening or launching', () => {
  const configure = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Configure Codex"]'
  )
  act(() => {
    configure?.focus()
    configure?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
  })
  expect(document.activeElement?.getAttribute('role')).toBe('menuitem')
  expect(document.body.textContent).not.toContain('Arguments')
  expect(launch).not.toHaveBeenCalled()
})

it('launches the searched default once from Enter', () => {
  const input = document.querySelector('input')!
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(
      input,
      'astra low'
    )
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() =>
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    )
  )
  expect(launch).toHaveBeenCalledOnce()
  expect(launch.mock.calls[0][1]).toMatchObject({
    surface: 'chat',
    choices: { model: 'astra', options: { effort: 'low' } }
  })
})

it('closes Configure with Escape without dispatch and returns focus to its trigger', async () => {
  const configure = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Configure Codex"]'
  )!
  act(() => configure.click())
  const search = document.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!
  act(() => {
    search.focus()
    search.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    )
  })
  expect(launch).not.toHaveBeenCalled()
  expect(document.querySelector('input[aria-label="Search models"]')).toBeNull()
  await waitFor(() => expect(document.activeElement).toBe(configure))
})

it('retains the setup draft on close/reopen and resets an open draft when its owner is replaced', () => {
  const own = {
    ...entry,
    ownerKey: 'pair7/runtime1',
    defaultSurface: 'terminal' as const,
    arguments: '--add-dir docs',
    terminal: { permissionMode: 'ask' as const }
  }
  const show = (value = own) =>
    act(() =>
      root.render(
        <TooltipProvider>
          <AgentLaunchSetupButton entry={value} onUse={launch} />
        </TooltipProvider>
      )
    )
  show()
  const configure = () =>
    document.querySelector<HTMLButtonElement>('button[aria-label="Configure Codex"]')!
  fireEvent.click(configure())
  fireEvent.change(document.querySelector('textarea')!, { target: { value: '--add-dir src' } })
  expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('--add-dir src')
  fireEvent.keyDown(document.querySelector('textarea')!, { key: 'Escape' })
  expect(document.querySelector('textarea')).toBeNull()
  fireEvent.click(configure())
  expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('--add-dir src')
  fireEvent.change(document.querySelector('textarea')!, {
    target: { value: '--add-dir old-owner' }
  })
  show({ ...own, ownerKey: 'pair8/runtime2', arguments: '--add-dir new-owner' })
  expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('--add-dir new-owner')
  fireEvent.click(
    [...document.querySelectorAll('button')].find((b) => b.textContent === 'Launch terminal')!
  )
  expect(launch).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ choices: {}, arguments: undefined })
  )
})

it('retains the whole row draft after outside dismissal, menu remount and launch', async () => {
  const own: AgentPickerEntry = {
    ...entry,
    agent: 'claude',
    label: 'Claude',
    ownerKey: 'retained-claude',
    defaultSurface: 'terminal',
    rows: [{ agent: 'claude', kind: 'cli' }],
    arguments: '--add-dir docs',
    terminal: { model: 'opus', permissionMode: 'ask' },
    catalog: {
      origin: 'probe',
      fetchedAt: 1,
      models: ['opus', 'sonnet'].map((id) => ({
        id,
        label: id,
        isDefault: id === 'opus',
        supportsFastMode: true,
        efforts: [
          { value: 'low', label: 'Low' },
          { value: 'high', label: 'High' }
        ]
      }))
    }
  }
  const showButton = (value = own) =>
    act(() =>
      root.render(
        <TooltipProvider>
          <AgentLaunchSetupButton entry={value} onUse={launch} />
        </TooltipProvider>
      )
    )
  showButton()
  const user = userEvent.setup()
  const configure = () =>
    document.querySelector<HTMLButtonElement>('button[aria-label="Configure Claude"]')!
  await user.click(configure())
  await user.click(
    [...document.querySelectorAll<HTMLElement>('[cmdk-item]')].find(
      (item) => item.textContent === 'sonnet'
    )!
  )
  await user.click(getByRole(document.body, 'radio', { name: 'High' }))
  await user.click(
    document.querySelector<HTMLButtonElement>('button[aria-label="Claude permissions"]')!
  )
  await user.click(
    [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) =>
      item.textContent?.startsWith('Full access')
    )!
  )
  await user.click(getByRole(document.body, 'switch'))
  const token = 'fdsafjdkslafjkdls;ajfkld;sjaklfd;'.repeat(40)
  fireEvent.change(document.querySelector('textarea')!, { target: { value: token } })
  const argumentsText = document.querySelector<HTMLTextAreaElement>('textarea')!.value
  expect(argumentsText).toContain(token)
  const assertDraft = () => {
    expect(document.querySelector('[cmdk-item][data-current="true"]')?.textContent).toBe('sonnet')
    expect(getByRole(document.body, 'radio', { name: 'High' }).getAttribute('data-state')).toBe(
      'on'
    )
    expect(
      document.querySelector('button[aria-label="Claude permissions"]')?.textContent
    ).toContain('Full access')
    expect(getByRole(document.body, 'switch').getAttribute('aria-checked')).toBe('true')
    expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(argumentsText)
    expect(
      document.querySelector('button[aria-label="Remove --dangerously-skip-permissions"]')
    ).not.toBeNull()
    expect(document.querySelector('button[aria-label*="Remove --settings"]')).not.toBeNull()
  }
  assertDraft()
  await user.click(document.body)
  await waitFor(() => expect(document.querySelector('textarea')).toBeNull())
  act(() => root.render(null))
  showButton()
  await user.click(configure())
  assertDraft()
  await user.click(getByRole(document.body, 'button', { name: 'Launch terminal' }))
  expect(launch).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      surface: 'terminal',
      choices: expect.objectContaining({
        model: 'sonnet',
        options: expect.objectContaining({ effort: 'high' })
      }),
      arguments: expect.stringContaining(token)
    })
  )
  act(() => root.render(null))
  showButton()
  await user.click(configure())
  assertDraft()
  showButton({ ...own, ownerKey: 'replacement-claude' })
  expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('--add-dir docs')
  expect(getByRole(document.body, 'switch').getAttribute('aria-checked')).toBe('false')
})
