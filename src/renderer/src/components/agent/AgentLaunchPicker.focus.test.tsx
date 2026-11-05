// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, getByRole, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AgentLaunchPicker } from './AgentLaunchPicker'
import type { NewTabAgentMenuModel } from '../tab-bar/use-new-tab-agent-menu-rows'
import * as inventoryModule from './use-agent-launch-picker-inventory'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'
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

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('keeps continuous trigger typing in the search inside a dialog', async () => {
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
  const show = (currentModel: NewTabAgentMenuModel = model, currentEntries = entries) =>
    act(() =>
      root.render(
        <TooltipProvider>
          <Dialog open>
            <DialogContent>
              <DialogTitle>Agent selection</DialogTitle>
              <AgentLaunchPicker
                model={currentModel}
                entries={currentEntries}
                agent="codex"
                onPick={launch}
              />
            </DialogContent>
          </Dialog>
        </TooltipProvider>
      )
    )
  show()
  const trigger = getByRole(document.body, 'button', { name: 'Select agent' })
  const search = () =>
    document.querySelector<HTMLInputElement>('input[placeholder="Search agents and setups…"]')
  fireEvent.keyDown(trigger, { key: 'c', metaKey: true })
  expect(search()).toBeNull()
  const user = userEvent.setup()
  act(() => trigger.focus())
  await user.keyboard('c')
  expect(document.activeElement).toBe(search())
  expect(search()?.value).toBe('c')
  expect(search()?.selectionStart).toBe(1)
  await user.keyboard('o')
  expect(document.activeElement).toBe(search())
  expect(search()?.value).toBe('co')
  expect(search()?.selectionStart).toBe(2)
  expect(document.querySelector('[aria-label="Configure Claude"]')).toBeNull()
  expect(launch).not.toHaveBeenCalled()
  // The row Enter would pick reads as highlighted, like the project and host comboboxes.
  expect(
    getByRole(document.body, 'menuitem', { name: /^Codex/ }).classList.contains('bg-accent')
  ).toBe(true)
  await user.keyboard('{Enter}')
  expect(launch).toHaveBeenCalledOnce()
  expect(launch.mock.calls[0][0]).toBe('codex')
  await waitFor(() => expect(document.activeElement).toBe(trigger))
  await user.click(trigger)
  expect(document.activeElement).toBe(search())
  expect(search()?.value).toBe('')
  await user.keyboard('{ArrowDown}')
  expect(document.activeElement).toBe(getByRole(document.body, 'menuitem', { name: /^Codex/ }))
  show(model, [...entries])
  expect(document.activeElement).toBe(getByRole(document.body, 'menuitem', { name: /^Codex/ }))
  show({ state: 'loading', placeholderCount: 2 })
  expect(search()).toBeNull()
  show()
  await waitFor(() => expect(document.activeElement).toBe(search()))
  await user.keyboard('co')
  expect(search()?.value).toBe('co')
  expect(search()?.selectionStart).toBe(2)
  await user.keyboard('{Escape}')
  await waitFor(() => expect(document.activeElement).toBe(trigger))
})
