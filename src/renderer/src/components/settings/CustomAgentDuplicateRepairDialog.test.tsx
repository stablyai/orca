// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { CustomAgentDuplicateRepairDialog } from './CustomAgentDuplicateRepairDialog'
import type { CustomTuiAgentId } from '../../../../shared/types'
import type {
  AgentCatalogMutation,
  CustomAgentDraft
} from '../../../../shared/agent-catalog-snapshot'
import type { DuplicateRepairRow } from './custom-agent-duplicate-repair-plan'

const mutateMock = vi.hoisted(() =>
  vi.fn<
    (mutation: AgentCatalogMutation) => Promise<{ ok: boolean; revision: number; code?: string }>
  >()
)

vi.mock('@/lib/agent-catalog-authoring', () => ({
  mutateAgentCatalog: (mutation: AgentCatalogMutation) => mutateMock(mutation)
}))

const DUP_ID = 'custom-agent:codex:11111111-1111-4111-8111-111111111111' as CustomTuiAgentId

function draft(label: string): CustomAgentDraft {
  return { label, commandOverride: null, args: '', env: {}, syncEnv: false }
}

function stubApi(): void {
  ;(globalThis as unknown as { window: { api: unknown } }).window.api = {
    settings: {
      agentCatalog: {
        getLocal: vi.fn(async () => ({ revision: 5 })),
        getLocalDraft: vi.fn(async () => ({ status: 'ready', revision: 5, draft: draft('kept') }))
      }
    }
  }
}

const ROWS: DuplicateRepairRow[] = [
  { repairToken: 'a', label: 'First', baseAgent: 'codex', draftAvailability: 'available' },
  { repairToken: 'b', label: 'Second', baseAgent: 'codex', draftAvailability: 'available' }
]

beforeEach(() => {
  mutateMock.mockReset()
  mutateMock.mockResolvedValue({ ok: true, revision: 6 })
  stubApi()
})

afterEach(() => cleanup())

function renderDialog(rows: DuplicateRepairRow[] = ROWS): { onResolved: ReturnType<typeof vi.fn> } {
  const onResolved = vi.fn()
  render(
    <CustomAgentDuplicateRepairDialog
      open
      duplicateId={DUP_ID}
      rows={rows}
      onOpenChange={vi.fn()}
      onResolved={onResolved}
    />
  )
  return { onResolved }
}

function rowChoice(rowLabel: string, choice: string): void {
  const row = screen.getByText(rowLabel).closest('div.space-y-2') as HTMLElement
  fireEvent.click(within(row).getByText(choice))
}

describe('CustomAgentDuplicateRepairDialog', () => {
  it('keeps submit disabled until every row has a choice', () => {
    renderDialog()
    const confirm = screen.getByText('Resolve agents').closest('button') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    rowChoice('First', 'Keep for existing references')
    expect(confirm.disabled).toBe(true)
    rowChoice('Second', 'Discard')
    expect(confirm.disabled).toBe(false)
  })

  it('only lets one row keep the shared id', () => {
    renderDialog()
    rowChoice('First', 'Keep for existing references')
    rowChoice('Second', 'Keep for existing references')
    // The second keep clears the first, leaving First without a choice again.
    const confirm = screen.getByText('Resolve agents').closest('button') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
  })

  it('commits the whole group as one atomic resolve-duplicate-id mutation', async () => {
    const { onResolved } = renderDialog()
    rowChoice('First', 'Keep for existing references')
    rowChoice('Second', 'Discard')
    fireEvent.click(screen.getByText('Resolve agents'))
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1))
    expect(mutateMock).toHaveBeenCalledWith({
      kind: 'resolve-duplicate-id',
      duplicateId: DUP_ID,
      rows: [
        {
          repairToken: 'a',
          action: { kind: 'keep-for-existing-references', repairedDraft: draft('kept') }
        },
        { repairToken: 'b', action: { kind: 'discard' } }
      ]
    })
  })

  it('surfaces a fail-closed stale-token result without resolving', async () => {
    // If the group changed under a mutateAgentCatalog auto-retry, the host's
    // revision-scoped repair tokens no longer resolve and the mutation returns
    // stale_agent_repair_token. The dialog must surface it, never silently apply.
    mutateMock.mockResolvedValue({ ok: false, revision: 6, code: 'stale_agent_repair_token' })
    const { onResolved } = renderDialog()
    rowChoice('First', 'Keep for existing references')
    rowChoice('Second', 'Discard')
    fireEvent.click(screen.getByText('Resolve agents'))
    await waitFor(() =>
      expect(
        screen.getByText('Could not resolve these agents. Reopen Settings and try again.')
      ).toBeTruthy()
    )
    expect(onResolved).not.toHaveBeenCalled()
  })

  it('disables keep and replace for a too-large row', () => {
    renderDialog([
      { repairToken: 'a', label: 'First', baseAgent: 'codex', draftAvailability: 'available' },
      { repairToken: 'big', label: 'Huge', baseAgent: 'codex', draftAvailability: 'too-large' }
    ])
    const row = screen.getByText('Huge').closest('div.space-y-2') as HTMLElement
    expect(
      (within(row).getByText('Keep for existing references').closest('button') as HTMLButtonElement)
        .disabled
    ).toBe(true)
    expect(
      (within(row).getByText('Replace as new').closest('button') as HTMLButtonElement).disabled
    ).toBe(true)
    expect((within(row).getByText('Discard').closest('button') as HTMLButtonElement).disabled).toBe(
      false
    )
  })
})
