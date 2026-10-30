// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
import {
  createComposerAgentEntry,
  type ComposerAgentEntry
} from '@/hooks/composer-state/composer-agent-entries'
import type { AgentPickerDraft } from '../../../../shared/agent-launch-picker'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { MAX_COMPOSER_AGENT_ROWS } from './new-workspace-composer-card-props'
import { NewWorkspaceComposerAgentSection } from './NewWorkspaceComposerAgentSection'

const mocks = vi.hoisted(() => ({ toastError: vi.fn() }))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

// The panel's own editing behaviour is covered by its tests; here only the row wiring matters.
vi.mock('@/components/agent/AgentLaunchSetupPanel', () => ({
  AgentLaunchSetupPanel: ({
    initial,
    onUse
  }: {
    initial?: AgentPickerDraft
    onUse: (draft: AgentPickerDraft) => void
  }) => (
    <button
      type="button"
      onClick={() => onUse({ ...(initial as AgentPickerDraft), arguments: '--profile fast' })}
    >
      Amend draft
    </button>
  )
}))

afterEach(cleanup)
beforeEach(() => mocks.toastError.mockClear())

function entryOf(agent: TuiAgent = 'codex', overrides: Partial<ComposerAgentEntry> = {}) {
  return { ...createComposerAgentEntry(agent), ...overrides }
}

function entryWithArguments(agent: TuiAgent, argumentsText: string): ComposerAgentEntry {
  const entry = createComposerAgentEntry(agent)
  return { ...entry, draft: { ...entry.draft, arguments: argumentsText } }
}

function renderSection(
  overrides: Partial<React.ComponentProps<typeof NewWorkspaceComposerAgentSection>> = {}
) {
  const props = {
    quickAgent: 'codex' as TuiAgent | null,
    onQuickAgentChange: vi.fn(),
    onOpenAgentSettings: vi.fn(),
    createDisabled: false,
    onCreate: vi.fn(),
    advancedOpen: false,
    onToggleAdvanced: vi.fn(),
    visibleQuickAgents: AGENT_CATALOG,
    defaultTuiAgent: 'blank' as TuiAgent | 'blank' | null,
    handleSetDefaultAgent: vi.fn(),
    ...overrides
  }
  const rendered = render(
    <TooltipProvider>
      <NewWorkspaceComposerAgentSection {...props} />
    </TooltipProvider>
  )
  return { props, ...rendered }
}

describe('NewWorkspaceComposerAgentSection agent picker', () => {
  it('offers Blank Terminal because a workspace can start without an agent', () => {
    const onQuickAgentChange = vi.fn()
    render(
      <TooltipProvider>
        <NewWorkspaceComposerAgentSection
          quickAgent="codex"
          onQuickAgentChange={onQuickAgentChange}
          onOpenAgentSettings={vi.fn()}
          createDisabled={false}
          onCreate={vi.fn()}
          advancedOpen={false}
          onToggleAdvanced={vi.fn()}
          visibleQuickAgents={AGENT_CATALOG}
          defaultTuiAgent="blank"
          handleSetDefaultAgent={vi.fn()}
        />
      </TooltipProvider>
    )

    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(screen.getByRole('option', { name: 'Blank Terminal' }))

    expect(onQuickAgentChange).toHaveBeenCalledWith(null)
  })

  it('keeps the only bare row on the single-agent layout', () => {
    const row = entryOf('codex')
    renderSection({ agentEntries: [row] })

    expect(screen.getByRole('combobox')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove agent' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Configure Codex' })).toBeNull()
  })

  it('still creates on Enter from the row 0 trigger', () => {
    const { props } = renderSection({ agentEntries: [entryOf('codex')] })

    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' })

    expect(props.onCreate).toHaveBeenCalledTimes(1)
  })

  it('appends a row through Add agent and removes any row while more than one remains', () => {
    const first = entryOf('codex')
    const second = entryOf('codex')
    const onAddAgentEntry = vi.fn()
    const onRemoveAgentEntry = vi.fn()
    const { props, rerender } = renderSection({
      agentEntries: [first],
      onAddAgentEntry,
      onRemoveAgentEntry
    })

    fireEvent.click(screen.getByRole('button', { name: 'Add agent' }))
    expect(onAddAgentEntry).toHaveBeenCalledTimes(1)

    rerender(
      <TooltipProvider>
        <NewWorkspaceComposerAgentSection {...props} agentEntries={[first, second]} />
      </TooltipProvider>
    )
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove agent' })[1])

    expect(onRemoveAgentEntry).toHaveBeenCalledWith(second.id)
  })

  it('shows a flags chip and a catalog-labelled name input per detailed row', () => {
    const row = entryWithArguments('codex', '--profile fast --model sonnet')
    const onAgentEntryChange = vi.fn()
    renderSection({ agentEntries: [row], onAgentEntryChange })

    const flags = screen.getByTitle('--profile fast --model sonnet')
    expect(flags.textContent).toBe('--profile fast…')
    const name = screen.getByPlaceholderText('Codex')
    expect(name).toHaveAttribute('maxlength', '60')

    fireEvent.change(name, { target: { value: 'Worker' } })
    expect(onAgentEntryChange).toHaveBeenCalledWith(row.id, { displayName: 'Worker' })
  })

  it('opens the row setup panel and writes its amended draft back to that row', async () => {
    const row = entryWithArguments('codex', '--profile fast')
    const other = entryOf('claude')
    const onAgentEntryChange = vi.fn()
    renderSection({ agentEntries: [row, other], onAgentEntryChange })

    fireEvent.click(screen.getAllByRole('button', { name: 'Configure Codex' })[0])
    fireEvent.click(await screen.findByRole('button', { name: 'Amend draft' }))

    expect(onAgentEntryChange).toHaveBeenCalledWith(row.id, {
      draft: expect.objectContaining({ agent: 'codex', arguments: '--profile fast' })
    })
    expect(screen.queryByRole('button', { name: 'Amend draft' })).toBeNull()
  })

  it('persists a detection-resolved row 0 pick before adding a row of the same harness', () => {
    const row = entryOf('claude')
    const onAgentEntryChange = vi.fn()
    const onAddAgentEntry = vi.fn()
    renderSection({
      quickAgent: 'codex',
      agentEntries: [row],
      onAgentEntryChange,
      onAddAgentEntry
    })

    fireEvent.click(screen.getByRole('button', { name: 'Add agent' }))

    expect(onAgentEntryChange).toHaveBeenCalledWith(row.id, {
      draft: expect.objectContaining({ agent: 'codex' })
    })
    expect(onAddAgentEntry).toHaveBeenCalledTimes(1)
  })

  it('reconciles row 0 with the combobox pick when only its name changes', () => {
    const staleRow = entryOf('claude')
    const second = entryOf('claude')
    const onAgentEntryChange = vi.fn()
    renderSection({
      quickAgent: 'codex',
      agentEntries: [staleRow, second],
      onAgentEntryChange
    })

    fireEvent.change(screen.getByPlaceholderText('Codex'), { target: { value: 'Worker' } })

    // The row shows Codex while its draft still names Claude; a name-only edit would otherwise
    // submit the stale harness.
    expect(onAgentEntryChange).toHaveBeenCalledWith(staleRow.id, {
      displayName: 'Worker',
      draft: expect.objectContaining({ agent: 'codex', choices: {}, arguments: undefined })
    })
  })

  it('stops adding at the row cap and explains why', () => {
    const rows = Array.from({ length: MAX_COMPOSER_AGENT_ROWS }, () => entryOf('codex'))
    const onAddAgentEntry = vi.fn()
    renderSection({ agentEntries: rows, onAddAgentEntry })

    const add = screen.getByRole('button', { name: 'Add agent' })
    expect(add).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(add)

    expect(onAddAgentEntry).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith('You can add up to 8 agents per workspace.')
  })

  it('warns that extra rows are ignored on a non-git target and disables them', () => {
    const first = entryOf('codex')
    const second = entryOf('claude')
    renderSection({ agentEntries: [first, second], agentEntriesLocked: true })

    expect(
      screen.getByText(
        'Multiple agents apply only to local git workspaces; later rows will be ignored'
      )
    ).toBeTruthy()
    const comboboxes = screen.getAllByRole('combobox')
    expect(comboboxes[0]).toBeEnabled()
    expect(comboboxes[1]).toBeDisabled()
    const names = screen.getAllByRole('textbox')
    expect(names[0]).toBeEnabled()
    expect(names[1]).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add agent' })).toBeDisabled()
  })
})
