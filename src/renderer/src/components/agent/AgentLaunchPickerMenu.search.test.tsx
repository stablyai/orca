// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type * as LaunchSetup from './AgentLaunchSetupButton'
import type { AgentLaunchSetupButton } from './AgentLaunchSetupButton'
import { AgentLaunchPickerMenu } from './AgentLaunchPickerMenu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'

vi.mock('@/hooks/useShortcutLabel', () => ({ useOptionalShortcutLabel: () => null }))
vi.mock('./AgentLaunchSetupButton', async (importOriginal) => ({
  ...(await importOriginal<typeof LaunchSetup>()),
  AgentLaunchSetupButton: vi.fn((props: ComponentProps<typeof AgentLaunchSetupButton>) => (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger asChild hideChevron>
        {props.renderAnchor?.(<button>Setup</button>)}
      </DropdownMenuSubTrigger>
    </DropdownMenuSub>
  ))
}))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('lists an agent named by the query before other agents’ model setups', () => {
  const codex: AgentPickerEntry = {
    agent: 'codex',
    label: 'Codex',
    rows: [{ agent: 'codex', kind: 'cli' }],
    surfaces: ['terminal'],
    defaultSurface: 'terminal',
    terminal: {},
    structured: {},
    catalog: { origin: 'probe', fetchedAt: 1, models: [] }
  }
  const opencode: AgentPickerEntry = {
    ...codex,
    agent: 'opencode',
    label: 'OpenCode',
    rows: [{ agent: 'opencode', kind: 'cli' }],
    catalog: {
      origin: 'probe',
      fetchedAt: 1,
      models: [{ id: 'gpt-5-codex', label: 'GPT-5 Codex', isDefault: false, efforts: [] }]
    }
  }
  const launch = vi.fn()
  render(
    <DropdownMenu defaultOpen modal={false}>
      <DropdownMenuTrigger>Open</DropdownMenuTrigger>
      <DropdownMenuContent>
        <AgentLaunchPickerMenu entries={[opencode, codex]} runLaunch={launch} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
  fireEvent.focus(screen.getByRole('textbox'))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'codex' } })
  const items = screen.getAllByRole('menuitem').map((item) => item.textContent)
  expect(items[0]).toContain('Codex')
  expect(items[0]).not.toContain('OpenCode')
  expect(items.some((text) => text?.includes('OpenCode · GPT-5 Codex'))).toBe(true)
  const highlighted = document.querySelectorAll('[data-search-default]')
  expect(highlighted).toHaveLength(1)
  expect(highlighted[0].textContent).toContain('Codex')
  expect(highlighted[0].textContent).not.toContain('OpenCode')
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
  expect(launch).toHaveBeenCalledWith({ agent: 'codex', kind: 'cli' }, undefined)
})
