// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentLaunchPickerMenu } from './AgentLaunchPickerMenu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'

vi.mock('@/hooks/useShortcutLabel', () => ({
  useOptionalShortcutLabel: () => null
}))
afterEach(cleanup)

const entry = (agent: 'codex' | 'claude', label: string): AgentPickerEntry => ({
  agent,
  label,
  rows: [{ agent, kind: 'cli' }],
  surfaces: ['terminal'],
  defaultSurface: 'terminal',
  terminal: {},
  structured: {},
  catalog: { origin: 'probe', fetchedAt: 1, models: [] }
})

it('offers "Set as default" when an agent row is right-clicked', () => {
  const onSetDefault = vi.fn()
  render(
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger>Open</DropdownMenuTrigger>
      <DropdownMenuContent>
        <AgentLaunchPickerMenu
          entries={[entry('codex', 'Codex'), entry('claude', 'Claude')]}
          runLaunch={vi.fn()}
          setupDisabled
          defaultAgent="claude"
          onSetDefault={onSetDefault}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
  const row = screen.getByRole('menuitem', { name: 'Codex' })
  const other = screen.getByRole('menuitem', { name: 'Claude' })
  fireEvent.contextMenu(row)
  // Hovering rows under the menu must not dismiss it.
  fireEvent.pointerMove(row, { pointerType: 'mouse' })
  fireEvent.pointerMove(other, { pointerType: 'mouse' })
  fireEvent.click(screen.getByRole('menuitem', { name: 'Set as default' }))
  expect(onSetDefault).toHaveBeenCalledWith('codex')
})
