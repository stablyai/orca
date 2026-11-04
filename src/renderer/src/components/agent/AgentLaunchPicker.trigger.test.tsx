// @vitest-environment happy-dom
import { act, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, getByRole } from '@testing-library/react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { AgentLaunchPicker } from './AgentLaunchPicker'
import { AgentLaunchPickerMenu } from './AgentLaunchPickerMenu'
import * as inventoryModule from './use-agent-launch-picker-inventory'
import type {
  AgentPickerDraft,
  AgentPickerEntry
} from '../../../../shared/agent-launch/picker/agent-launch-picker'
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
      { id: 'astra', label: 'Astra', isDefault: false, efforts: [{ value: 'low', label: 'Low' }] }
    ]
  }
}
let root: Root
let host: HTMLDivElement
let owner = 0
const launch = vi.fn()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  entry.ownerKey = `trigger-test-${owner++}`
  launch.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

it('requests current supplied inventory after Agent Settings closes the root programmatically', () => {
  const claude: AgentPickerEntry = {
    ...entry,
    agent: 'claude',
    label: 'Claude',
    rows: [{ agent: 'claude', kind: 'cli' }]
  }
  const entries = [entry, claude]
  vi.spyOn(inventoryModule, 'useAgentLaunchPickerInventory').mockReturnValue([])
  const onCatalogOpen = vi.fn()
  const onOpenChange = vi.fn()
  const onOpenAgentSettings = vi.fn()
  const model = {
    state: 'settled' as const,
    rows: entries.flatMap((entry) => entry.rows),
    detection: {
      detectedIds: entries.map((entry) => entry.agent),
      isLoading: false,
      isRefreshing: false,
      detectionFailed: false,
      needsServerUpdate: false,
      refresh: async () => entries.map((entry) => entry.agent)
    }
  }
  const show = (agent: AgentPickerEntry['agent']) =>
    act(() =>
      root.render(
        <TooltipProvider>
          <AgentLaunchPicker
            model={model}
            entries={entries}
            agent={agent}
            onPick={launch}
            onCatalogOpen={onCatalogOpen}
            onOpenChange={onOpenChange}
            onOpenAgentSettings={onOpenAgentSettings}
          />
        </TooltipProvider>
      )
    )
  const open = () =>
    fireEvent.pointerDown(getByRole(document.body, 'button', { name: 'Select agent' }), {
      button: 0
    })
  show('claude')
  fireEvent.keyDown(getByRole(document.body, 'button', { name: 'Select agent' }), { key: 'l' })
  expect(onOpenChange).toHaveBeenLastCalledWith(true)
  fireEvent.click(getByRole(document.body, 'button', { name: 'Configure Claude' }))
  fireEvent.keyDown(document.querySelector('input[aria-label="Search models"]')!, {
    key: 'ArrowLeft'
  })
  fireEvent.click(getByRole(document.body, 'menuitem', { name: 'Agent settings…' }))
  expect(onOpenAgentSettings).toHaveBeenCalledTimes(1)
  expect(onOpenChange.mock.calls).toEqual([[true], [false]])
  expect(onCatalogOpen.mock.calls).toEqual([['claude'], ['claude']])
  show('codex')
  expect(onCatalogOpen.mock.calls).toEqual([['claude'], ['claude']])
  open()
  expect(onOpenChange.mock.calls).toEqual([[true], [false], [true]])
  expect(
    document.querySelector<HTMLInputElement>('input[placeholder="Search agents and setups…"]')
      ?.value
  ).toBe('')
  expect(onCatalogOpen.mock.calls).toEqual([['claude'], ['claude'], ['codex']])
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it.each([
  ['opus', 'Opus'],
  ['sonnet', 'Sonnet'],
  ['vendor/myMODEL-v2', 'vendor/myMODEL-v2']
])(
  'keeps the selected %s caption stable through lazy catalog publication and reopen',
  (id, caption) => {
    const value: AgentPickerDraft = {
      agent: 'claude',
      surface: 'terminal',
      choices: { model: id },
      arguments: '--debug'
    }
    const original = structuredClone(value)
    let catalog: AgentPickerEntry['catalog'] = { origin: 'unknown' }
    let publish = () => {}
    const inventory = vi
      .spyOn(inventoryModule, 'useAgentLaunchPickerInventory')
      .mockImplementation(() => {
        const current = useSyncExternalStore(
          (notify) => {
            publish = notify
            return () => {}
          },
          () => catalog
        )
        return [
          {
            ...entry,
            agent: 'claude',
            label: 'Claude',
            rows: [{ agent: 'claude', kind: 'cli' }],
            catalog: current
          }
        ]
      })
    const model = {
      state: 'settled' as const,
      rows: [{ agent: 'claude' as const, kind: 'cli' as const }],
      detection: {
        detectedIds: ['claude' as const],
        isLoading: false,
        isRefreshing: false,
        detectionFailed: false,
        needsServerUpdate: false,
        refresh: async () => ['claude' as const]
      }
    }
    const renderPicker = () =>
      act(() =>
        root.render(
          <TooltipProvider>
            <AgentLaunchPicker model={model} value={value} agent="claude" onPick={launch} />
          </TooltipProvider>
        )
      )
    let button: HTMLElement
    const trigger = () => button
    const expectCaption = () => expect(trigger().textContent).toBe(`Claude · ${caption}`)
    renderPicker()
    button = getByRole(document.body, 'button', { name: 'Select agent' })
    expect(inventory.mock.calls.at(-1)?.[2]).toBe(false)
    expectCaption()
    fireEvent.pointerDown(trigger(), { button: 0, ctrlKey: false })
    expectCaption()
    catalog = {
      origin: 'probe',
      fetchedAt: 1,
      models: [{ id, label: 'Different live friendly label', isDefault: false, efforts: [] }]
    }
    act(() => publish())
    expectCaption()
    fireEvent.change(document.querySelector('input[placeholder="Search agents and setups…"]')!, {
      target: { value: 'friendly' }
    })
    expect(document.body.textContent).toContain('Different live friendly label')
    fireEvent.keyDown(getByRole(document.body, 'menu'), { key: 'Escape' })
    expectCaption()
    fireEvent.pointerDown(trigger(), { button: 0, ctrlKey: false })
    expectCaption()
    expect(value).toEqual(original)
    expect(launch).not.toHaveBeenCalled()
  }
)

it.each(['button', 'enter'] as const)(
  'publishes named equal-default selection through argument four on %s',
  (activation) => {
    const initial: AgentPickerDraft = {
      agent: 'codex',
      surface: 'chat',
      choices: { model: 'astra', options: { effort: 'low' } },
      arguments: '--search',
      argumentsOwner: entry.ownerKey
    }
    const setupEntry = { ...entry, arguments: '--search' }
    act(() =>
      root.render(
        <TooltipProvider>
          <DropdownMenu defaultOpen modal={false}>
            <DropdownMenuTrigger>Select agent</DropdownMenuTrigger>
            <DropdownMenuContent>
              <AgentLaunchPickerMenu
                entries={[setupEntry]}
                mode="select"
                value={initial}
                runLaunch={launch}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </TooltipProvider>
      )
    )
    fireEvent.click(getByRole(document.body, 'button', { name: 'Configure Codex' }))
    if (activation === 'enter') {
      fireEvent.keyDown(document.querySelector('input[aria-label="Search models"]')!, {
        key: 'Enter'
      })
    } else {
      fireEvent.click(getByRole(document.body, 'button', { name: 'Launch chat' }))
    }
    expect(launch).toHaveBeenCalledExactlyOnceWith(
      { agent: 'codex', kind: 'chat', executionHostId: undefined },
      initial,
      setupEntry,
      'chat'
    )
  }
)

it('opens from a printable key on the focused trigger and seeds the search', () => {
  const claude: AgentPickerEntry = {
    ...entry,
    agent: 'claude',
    label: 'Claude',
    rows: [{ agent: 'claude', kind: 'cli' }]
  }
  const entries = [entry, claude]
  vi.spyOn(inventoryModule, 'useAgentLaunchPickerInventory').mockReturnValue([])
  const model = {
    state: 'settled' as const,
    rows: entries.flatMap((entry) => entry.rows),
    detection: {
      detectedIds: entries.map((entry) => entry.agent),
      isLoading: false,
      isRefreshing: false,
      detectionFailed: false,
      needsServerUpdate: false,
      refresh: async () => entries.map((entry) => entry.agent)
    }
  }
  act(() =>
    root.render(
      <TooltipProvider>
        <AgentLaunchPicker model={model} entries={entries} agent="codex" onPick={launch} />
      </TooltipProvider>
    )
  )
  const trigger = getByRole(document.body, 'button', { name: 'Select agent' })
  const search = () =>
    document.querySelector<HTMLInputElement>('input[placeholder="Search agents and setups…"]')
  fireEvent.keyDown(trigger, { key: 'c', metaKey: true })
  expect(search()).toBeNull()
  fireEvent.keyDown(trigger, { key: 'l' })
  expect(search()?.value).toBe('l')
  expect(getByRole(document.body, 'button', { name: 'Configure Claude' })).toBeTruthy()
  expect(document.querySelector('[aria-label="Configure Codex"]')).toBeNull()
  fireEvent.keyDown(getByRole(document.body, 'menu'), { key: 'Escape' })
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
  expect(search()?.value).toBe('')
})
