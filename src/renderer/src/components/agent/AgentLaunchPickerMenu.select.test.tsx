// @vitest-environment happy-dom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentLaunchPickerMenu } from './AgentLaunchPickerMenu'
import { useAgentPickerDraftScope } from './agent-launch-picker-drafts'
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

// A form that re-derives each entry's draft from what it saved and resets its draft scope, as Automations do.
function Form({ query, onPick }: { query: string; onPick: (draft?: AgentPickerDraft) => void }) {
  const [saved, setSaved] = useState<AgentPickerDraft['choices']>({})
  const draftScope = useAgentPickerDraftScope(saved.model)
  return (
    <TooltipProvider>
      <DropdownMenu defaultOpen modal={false}>
        <DropdownMenuTrigger>Agent</DropdownMenuTrigger>
        <DropdownMenuContent>
          <AgentLaunchPickerMenu
            entries={[entry]}
            mode="select"
            draftScope={draftScope}
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

it.each([['a search-result row', 'astra low']])(
  'applies each model and effort picked in %s setup to the form and keeps the panel on them',
  (_row, query) => {
    const onPick = vi.fn()
    render(<Form query={query} onPick={onPick} />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Configure Codex' })[0])
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
    // Typed Arguments stay staged in the panel across a close, after the form took its picks.
    fireEvent.change(screen.getByRole('textbox', { name: 'Arguments' }), {
      target: { value: '--search' }
    })
    fireEvent.keyDown(screen.getByRole('menu', { name: 'Configure Codex' }), { key: 'Escape' })
    expect(screen.queryByRole('menu', { name: 'Configure Codex' })).toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: 'Configure Codex' })[0])
    expect(screen.getByRole('textbox', { name: 'Arguments' })).toHaveProperty('value', '--search')
  }
)
