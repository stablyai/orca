// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { AgentLaunchSetupButton } from './AgentLaunchSetupButton'
import { AgentLaunchPickerMenu } from './AgentLaunchPickerMenu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { AgentPickerEntry } from '../../../../shared/agent-launch-picker'

vi.mock('@/hooks/useShortcutLabel', () => ({ useOptionalShortcutLabel: () => null }))
vi.mock('./AgentLaunchSetupButton', () => ({
  AgentLaunchSetupButton: vi.fn((props: ComponentProps<typeof AgentLaunchSetupButton>) =>
    props.renderAnchor?.(<button>Setup</button>)
  )
}))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('skips unchanged search rows on unrelated inventory updates and launches current choices', () => {
  const codex: AgentPickerEntry = {
    agent: 'codex',
    label: 'Codex',
    rows: [{ agent: 'codex', kind: 'cli' }],
    surfaces: ['terminal'],
    defaultSurface: 'terminal',
    terminal: {},
    structured: {},
    catalog: {
      origin: 'probe',
      fetchedAt: 1,
      models: [
        {
          id: 'host-model',
          label: 'Host model',
          isDefault: true,
          efforts: [{ value: 'low', label: 'Low' }]
        }
      ]
    }
  }
  const claude: AgentPickerEntry = {
    ...codex,
    agent: 'claude',
    label: 'Claude',
    rows: [{ agent: 'claude', kind: 'cli' }],
    catalog: { origin: 'probe', fetchedAt: 1, models: [] }
  }
  const launch = vi.fn()
  const menu = (entries: AgentPickerEntry[]) => (
    <DropdownMenu defaultOpen modal={false}>
      <DropdownMenuTrigger>Open</DropdownMenuTrigger>
      <DropdownMenuContent>
        <AgentLaunchPickerMenu entries={entries} runLaunch={launch} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
  const view = render(menu([codex, claude]))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'host low' } })
  expect(screen.getByRole('menuitem').textContent).toContain('Codex · Host model · Low')
  expect(vi.mocked(AgentLaunchSetupButton).mock.lastCall?.[0].initial).toEqual({
    agent: 'codex',
    surface: 'terminal',
    choices: { model: 'host-model', options: { effort: 'low' } }
  })
  vi.mocked(AgentLaunchSetupButton).mockClear()
  view.rerender(
    menu([codex, { ...claude, catalog: { origin: 'probe', fetchedAt: 2, models: [] } }])
  )
  expect(AgentLaunchSetupButton).not.toHaveBeenCalled()

  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'host' } })
  expect(AgentLaunchSetupButton).toHaveBeenCalled()
  fireEvent.click(screen.getByRole('menuitem'))
  expect(launch).toHaveBeenCalledWith(
    expect.objectContaining({ agent: 'codex', kind: 'cli' }),
    { agent: 'codex', surface: 'terminal', choices: { model: 'host-model' } },
    codex
  )
})
