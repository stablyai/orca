// @vitest-environment happy-dom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentLaunchPickerMenu } from './AgentLaunchPickerMenu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { TooltipProvider } from '@/components/ui/tooltip'
import type {
  AgentPickerDraft,
  AgentPickerEntry
} from '../../../../shared/agent-launch/picker/agent-launch-picker'
vi.mock('@/hooks/useShortcutLabel', () => ({ useOptionalShortcutLabel: () => null }))
afterEach(cleanup)

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

// A form that re-derives each entry's draft from what it saved, as Automations and settings do.
function Form({ query, onPick }: { query: string; onPick: (draft?: AgentPickerDraft) => void }) {
  const [saved, setSaved] = useState<AgentPickerDraft['choices']>({})
  return (
    <TooltipProvider>
      <DropdownMenu defaultOpen modal={false}>
        <DropdownMenuTrigger>Agent</DropdownMenuTrigger>
        <DropdownMenuContent>
          <AgentLaunchPickerMenu
            entries={[entry]}
            mode="select"
            initialQuery={query}
            draftForEntry={() => ({ agent: 'codex', surface: 'terminal', choices: { ...saved } })}
            runLaunch={(_row, draft) => {
              onPick(draft)
              if (draft) {
                setSaved(draft.choices)
              }
            }}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  )
}

it.each([
  ['an agent row', ''],
  ['a search-result row', 'astra low']
])(
  'applies each model and effort picked in %s setup to the form while the panel stays put',
  (_row, query) => {
    const onPick = vi.fn()
    render(<Form query={query} onPick={onPick} />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Configure Codex' })[0])
    const search = screen.getByLabelText('Search models')
    fireEvent.click(screen.getByRole('option', { name: 'Luna' }))
    expect(onPick).toHaveBeenLastCalledWith(
      expect.objectContaining({ choices: expect.objectContaining({ model: 'luna' }) })
    )
    expect(screen.getByRole('option', { name: 'Luna' }).getAttribute('data-current')).toBe('true')
    fireEvent.click(screen.getByRole('radio', { name: 'High' }))
    expect(onPick).toHaveBeenLastCalledWith(
      expect.objectContaining({
        choices: expect.objectContaining({ model: 'luna', options: { effort: 'high' } })
      })
    )
    expect(screen.getByLabelText('Search models')).toBe(search)
  }
)
