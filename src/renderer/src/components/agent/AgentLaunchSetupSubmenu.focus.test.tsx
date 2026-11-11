// @vitest-environment happy-dom
import { act, useState, type ReactElement } from 'react'
import { fireEvent, waitFor } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { AgentLaunchSetupButton } from './AgentLaunchSetupButton'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'

vi.mock('@/hooks/useShortcutLabel', () => ({ useOptionalShortcutLabel: () => null }))

const entry: AgentPickerEntry = {
  agent: 'codex',
  label: 'codex',
  rows: [{ agent: 'codex', kind: 'terminal' }],
  surfaces: ['chat', 'terminal'],
  defaultSurface: 'terminal',
  terminal: {},
  structured: {},
  catalog: {
    origin: 'probe',
    fetchedAt: 1,
    models: [{ id: 'astra', label: 'Astra', isDefault: true, efforts: [] }]
  }
}
const anchor = (trigger: ReactElement) => <div>{trigger}</div>
let root: Root
let host: HTMLDivElement
let setOpen: (open: boolean) => void
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

function Omnibox() {
  const [open, changeOpen] = useState(false)
  setOpen = changeOpen
  return (
    <TooltipProvider>
      <DropdownMenu defaultOpen modal={false}>
        <DropdownMenuTrigger>New tab</DropdownMenuTrigger>
        <DropdownMenuContent>
          <input aria-label="Query" />
          <button type="button">Elsewhere</button>
          <AgentLaunchSetupButton
            entry={entry}
            open={open}
            onOpenChange={changeOpen}
            returnFocus={() => document.querySelector<HTMLInputElement>('input')?.focus()}
            onUse={vi.fn()}
            renderAnchor={anchor}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  )
}

async function openWithFocusInPanel() {
  act(() => root.render(<Omnibox />))
  fireEvent.click(document.querySelector('button[aria-label="Configure codex"]')!)
  await waitFor(() => expect(document.querySelector('[cmdk-input]:not(:disabled)')).not.toBeNull())
  const search = document.querySelector<HTMLInputElement>('[cmdk-input]')!
  search.focus()
  expect(document.activeElement).toBe(search)
}

it('returns typing to the caller input when the caller closes a focused setup', async () => {
  await openWithFocusInPanel()
  act(() => setOpen(false))
  await waitFor(() => expect(document.querySelector('[cmdk-input]')).toBeNull())
  expect(document.activeElement).toBe(document.querySelector('input[aria-label="Query"]'))
})

it('leaves focus where the user moved it when the setup then closes', async () => {
  await openWithFocusInPanel()
  const elsewhere = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === 'Elsewhere'
  )!
  elsewhere.focus()
  act(() => setOpen(false))
  await waitFor(() => expect(document.querySelector('[cmdk-input]')).toBeNull())
  expect(document.activeElement).toBe(elsewhere)
})
