// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentLaunchPickerMenu } from './AgentLaunchPickerMenu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'
vi.mock('@/hooks/useShortcutLabel', () => ({ useOptionalShortcutLabel: () => null }))
afterEach(cleanup)

it('applies a model or effort picked in a form setup panel to the form while the panel stays open', () => {
  const efforts = [
    { value: 'low', label: 'Low' },
    { value: 'high', label: 'High' }
  ]
  const entry: AgentPickerEntry = {
    agent: 'codex',
    label: 'Codex',
    defaultSurface: 'terminal',
    surfaces: ['chat', 'terminal'],
    terminal: {},
    structured: {},
    catalog: {
      origin: 'probe',
      fetchedAt: 1,
      models: [
        { id: 'astra', label: 'Astra', isDefault: true, efforts },
        { id: 'luna', label: 'Luna', isDefault: false, efforts }
      ]
    },
    rows: [{ kind: 'cli', agent: 'codex', chat: true }]
  }
  const pick = vi.fn()
  render(
    <TooltipProvider>
      <DropdownMenu defaultOpen modal={false}>
        <DropdownMenuTrigger>Agent</DropdownMenuTrigger>
        <DropdownMenuContent>
          <AgentLaunchPickerMenu entries={[entry]} mode="select" runLaunch={pick} />
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: 'Configure Codex' }))
  fireEvent.click(screen.getByRole('option', { name: 'Luna' }))
  expect(pick).toHaveBeenLastCalledWith(
    { agent: 'codex', kind: 'cli', executionHostId: undefined },
    expect.objectContaining({ choices: expect.objectContaining({ model: 'luna' }) }),
    entry
  )
  fireEvent.click(screen.getByRole('radio', { name: 'High' }))
  expect(pick).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({
      choices: expect.objectContaining({ model: 'luna', options: { effort: 'high' } })
    }),
    entry
  )
  expect(screen.getByRole('menu', { name: 'Configure Codex' })).not.toBeNull()
})
