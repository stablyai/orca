import {
  entry,
  pickerResizeObservers as observers,
  pickerMovementObservers as movements,
  ResizeObserverFixture,
  IntersectionObserverFixture,
  compilePickerTerminalLaunch,
  codexAskRetainedArgsTokens
} from './agent-launch-picker-menu-test-fixture'
// @vitest-environment happy-dom
import { clearNativeChatComposerDraftsForTests } from '../native-chat/native-chat-composer-draft-store'
import { act } from 'react'
import * as floating from '@floating-ui/dom'
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

vi.mock('@floating-ui/dom', async (importOriginal) => {
  const actual = await importOriginal<typeof floating>()
  return { ...actual, autoUpdate: vi.fn(actual.autoUpdate) }
})
vi.mock('@/hooks/useShortcutLabel', () => ({ useOptionalShortcutLabel: () => null }))

const { autoUpdate } = await vi.importActual<typeof floating>('@floating-ui/dom')

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
  clearNativeChatComposerDraftsForTests()
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
        getByRole(document.body, 'slider', { name: 'Effort' }).getAttribute('aria-valuetext')
      ).toBe(preferred === 'chat' ? 'High' : 'Low')
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

it('bounds open geometry work at 10/100 catalog options and retires measurements with the native owner', async () => {
  let updates = 0
  const active = new Set<Element>()
  vi.spyOn(floating, 'autoUpdate').mockImplementation((reference, element, update, options) => {
    if (element !== null || !(reference instanceof Element)) {
      return autoUpdate(reference, element, update, options)
    }
    active.add(reference)
    const stop = autoUpdate(
      reference,
      element,
      () => {
        updates++
        update()
      },
      options
    )
    return () => {
      stop()
      active.delete(reference)
    }
  })
  const counts: number[] = []
  const user = userEvent.setup()
  for (const size of [10, 100]) {
    act(() => root.render(null))
    observers.clear()
    movements.clear()
    vi.stubGlobal('ResizeObserver', ResizeObserverFixture)
    vi.stubGlobal('IntersectionObserver', IntersectionObserverFixture)
    const value: AgentPickerEntry = {
      ...entry,
      ownerKey: `${entry.ownerKey}/geometry-${size}`,
      catalog: {
        origin: 'probe',
        fetchedAt: 1,
        models: Array.from({ length: size }, (_, i) => ({
          id: `preset-${i}`,
          label: `Preset ${i}`,
          isDefault: i === 0,
          efforts: []
        }))
      }
    }
    show(value)
    fireEvent.change(getByRole(document.body, 'textbox', { name: '' }), {
      target: { value: 'Preset' }
    })
    const renderedRows = document.querySelectorAll('button[aria-label="Configure Codex"]').length
    expect(renderedRows).toBeGreaterThan(0)
    expect(renderedRows).toBeLessThanOrEqual(8)
    updates = 0
    fireEvent(window, new Event('resize'))
    expect(updates).toBe(0)
    expect(active.size).toBe(0)
    expect(
      [...observers].some((observer) =>
        [...observer.targets].some((target) => target.matches('[role="menuitem"]'))
      )
    ).toBe(false)
    expect(
      [...movements].some((observer) =>
        [...observer.targets].some((target) => target.matches('[role="menuitem"]'))
      )
    ).toBe(false)
    const configure = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Configure Codex"]'
    )!
    await user.click(configure)
    await waitFor(() => expect(active.size).toBe(1))
    updates = 0
    act(() => fireEvent(window, new Event('resize')))
    expect(updates).toBeGreaterThan(0)
    expect(updates).toBeLessThanOrEqual(2)
    counts.push(updates)
    // Content-only reflow may reposition Radix; it must not feed overlap measurement.
    const panel = getByRole(document.body, 'menu', { name: 'Configure Codex' })
    updates = 0
    act(() => {
      for (const observer of new Set(observers)) {
        if (observer.targets.has(panel) || observer.targets.has(panel.parentElement!)) {
          observer.callback([], observer)
        }
      }
    })
    expect(updates).toBe(0)
    await user.keyboard('{Escape}')
    expect(active.size).toBe(0)
    expect([...observers].some((observer) => observer.targets.has(document.documentElement))).toBe(
      false
    )
    updates = 0
    fireEvent(window, new Event('resize'))
    expect(updates).toBe(0)
    await user.click(configure)
    expect(active.size).toBe(1)
    // Replacing the agent source retires its active row, before the root is disposed.
    show({ ...value, agent: 'claude', label: 'Claude' })
    expect(active.size).toBe(0)
    act(() => root.render(null))
    expect([...observers].flatMap((observer) => [...observer.targets])).toEqual([])
    expect([...movements].flatMap((observer) => [...observer.targets])).toEqual([])
    updates = 0
    fireEvent(window, new Event('resize'))
    expect(updates).toBe(0)
    expect(launch).not.toHaveBeenCalled()
    process.stdout.write(
      `${JSON.stringify({ metric: 'native-open-geometry-bound', catalogOptions: size, renderedRows, viewportUpdates: counts.at(-1), closedUpdates: updates, activeAfterRetirement: active.size })}\n`
    )
  }
  expect(counts[1]).toBe(counts[0])
})

it('opens setup with a clicked chevron without launching, then dispatches its selected surface once', () => {
  const configure = getByRole(document.body, 'button', { name: 'Configure Codex' })
  expect(configure?.closest('[data-agent-launch-row]')?.getAttribute('data-slot')).toBe(
    'dropdown-menu-sub-trigger'
  )
  expect(configure?.previousElementSibling?.getAttribute('data-orientation')).not.toBe('vertical')
  act(() => configure?.click())
  expect(launch).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('Arguments')
  expect(getByRole(document.body, 'menu', { name: 'Configure Codex' })).not.toBeNull()
  const terminal = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.getAttribute('aria-label') === 'Launch terminal'
  )
  act(() => terminal?.click())
  expect(launch).toHaveBeenCalledTimes(1)
  expect(launch.mock.calls[0]).toMatchObject([
    { agent: 'codex', kind: 'cli' },
    { agent: 'codex', surface: 'terminal', choices: {} },
    entry
  ])
})
it('opens the setup panel on the menu layer so it stacks above the new tab menu', () => {
  act(() => getByRole(document.body, 'button', { name: 'Configure Codex' }).click())
  // happy-dom computes no stacking, so compare the z-index utilities the layers come from.
  const layer = (element: HTMLElement) => element.className.match(/\bz-\[\d+\]/)?.[0]
  const panel = layer(getByRole(document.body, 'menu', { name: 'Configure Codex' }))
  expect(panel).toBe(
    layer(document.querySelector<HTMLElement>('[data-slot="dropdown-menu-content"]')!)
  )
  expect(panel).not.toBe('z-[60]')
})
it('keeps setup open while the pointer expands and collapses Arguments', async () => {
  const user = userEvent.setup()
  await user.click(
    document.querySelector<HTMLButtonElement>('button[aria-label="Configure Codex"]')!
  )
  const panel = document.querySelector('[data-slot="dropdown-menu-sub-content"]')!
  expect(panel).not.toBeNull()
  expect(panel.querySelector('textarea[aria-label="Arguments"]')).toBeNull()
  const toggle = panel.querySelector<HTMLButtonElement>('button[aria-label="Toggle Arguments"]')!
  await user.hover(toggle)
  expect(document.querySelector('[data-slot="dropdown-menu-sub-content"]')).toBe(panel)
  await user.click(toggle)
  expect(document.querySelector('[data-slot="dropdown-menu-sub-content"]')).toBe(panel)
  expect(panel.querySelector('textarea[aria-label="Arguments"]')).not.toBeNull()
  await user.click(toggle)
  expect(document.querySelector('[data-slot="dropdown-menu-sub-content"]')).toBe(panel)
  expect(panel.querySelector('textarea[aria-label="Arguments"]')).toBeNull()
  expect(launch).not.toHaveBeenCalled()
})

it('opens on chevron hover, crosses into setup, and switches agents without launching', async () => {
  show(entry, [
    { ...entry, agent: 'claude', label: 'Claude', rows: [{ agent: 'claude', kind: 'chat' }] }
  ])
  const user = userEvent.setup()
  const codex = getByRole(document.body, 'button', { name: 'Configure Codex' })
  await user.hover(codex)
  const panel = await waitFor(() => getByRole(document.body, 'menu', { name: 'Configure Codex' }))
  await user.hover(panel)
  expect(panel.isConnected).toBe(true)
  const claude = getByRole(document.body, 'button', { name: 'Configure Claude' })
  await user.hover(claude)
  await waitFor(() =>
    expect(document.querySelectorAll('[data-slot="dropdown-menu-sub-content"]')).toHaveLength(1)
  )
  await waitFor(() =>
    expect(getByRole(document.body, 'menu', { name: 'Configure Claude' })).toBeTruthy()
  )
  expect(panel.isConnected).toBe(false)
  expect(launch).not.toHaveBeenCalled()
})

it('opens with ArrowRight and returns to the trigger with ArrowLeft', async () => {
  const user = userEvent.setup()
  const row = document.querySelector<HTMLElement>('[data-agent-launch-row]')!
  act(() => row.focus())
  await user.keyboard('{ArrowRight}')
  const panel = getByRole(document.body, 'menu', { name: 'Configure Codex' })
  act(() => getByRole(panel, 'button', { name: 'Toggle Arguments' }).focus())
  await user.keyboard('{ArrowLeft}')
  expect(document.querySelector('[data-slot="dropdown-menu-sub-content"]')).toBeNull()
  expect(document.activeElement).toBe(row)
  expect(launch).not.toHaveBeenCalled()
})

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
  const panel = document.querySelector('[data-slot="dropdown-menu-sub-content"]')!
  const model = panel.querySelector<HTMLElement>('[cmdk-item]')!
  await user.hover(model)
  await user.click(model)
  expect(document.querySelector('[data-slot="dropdown-menu-sub-content"]')).toBe(panel)
  await user.click(
    panel.querySelector<HTMLButtonElement>('button[aria-label="Claude permissions"]')!
  )
  await user.click(
    [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) =>
      item.textContent?.startsWith('Full access')
    )!
  )
  expect(document.querySelector('[data-slot="dropdown-menu-sub-content"]')).toBe(panel)
  await user.click(panel.querySelector<HTMLButtonElement>('button[aria-label="Toggle Arguments"]')!)
  const chip = panel.querySelector<HTMLButtonElement>('button[aria-label*="Remove --settings"]')!
  expect(chip).not.toBeNull()
  await user.click(chip)
  expect(document.querySelector('[data-slot="dropdown-menu-sub-content"]')).toBe(panel)
  expect(panel.querySelector('button[aria-label*="Remove --settings"]')).toBeNull()
  expect(panel.querySelector<HTMLTextAreaElement>('textarea')?.value).toContain('"theme":"light"')
  await user.click(document.body)
  expect(document.querySelector('[data-slot="dropdown-menu-sub-content"]')).toBeNull()
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
    (button) => button.getAttribute('aria-label') === 'Launch terminal'
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
  const configure = getByRole(document.body, 'button', { name: 'Configure Codex' })
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
  const configure = getByRole(document.body, 'button', { name: 'Configure Codex' })!
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

it('retains authored Arguments on close/reopen and rebinds their acquisition authority', () => {
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
  expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('--add-dir old-owner')
  fireEvent.click(
    [...document.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'Launch terminal'
    )!
  )
  expect(launch).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      arguments: '--add-dir old-owner',
      argumentsOwner: 'pair8/runtime2'
    })
  )
  expect(
    compilePickerTerminalLaunch(launch.mock.lastCall![0], {
      ...own,
      ownerKey: 'pair8/runtime2',
      arguments: '--add-dir new-owner'
    })
  ).toMatchObject({
    ok: true,
    tokens: codexAskRetainedArgsTokens
  })
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
    expect(
      getByRole(document.body, 'slider', { name: 'Effort' }).getAttribute('aria-valuetext')
    ).toBe('High')
    expect(
      document.querySelector('button[aria-label="Claude permissions"]')?.textContent
    ).toContain('Full access')
    expect(getByRole(document.body, 'switch').getAttribute('aria-checked')).toBe('true')
    expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(argumentsText)
    expect(
      document.querySelector(
        'button[aria-label="Remove --dangerously-skip-permissions and use Claude\'s own settings"]'
      )
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
  assertDraft()
})
