// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { CustomTuiAgentId } from '../../../../shared/types'
import type { AgentReferenceSummary } from '../../../../shared/agent-reference-snapshot'
import { CustomAgentDisableDialog } from './CustomAgentDisableDialog'

type MutationResult =
  | { ok: true; revision: number }
  | { ok: false; code: string; revision: number; snapshot?: { revision: number } }

const disableMock = vi.hoisted(() =>
  vi.fn<(agent: string, enabled: boolean, revision: number) => Promise<MutationResult>>()
)
const refreshMock = vi.hoisted(() => ({ value: [] as AgentReferenceSummary[] }))

vi.mock('@/lib/agent-catalog-authoring', () => ({
  setTuiAgentEnabledAtRevision: (agent: string, enabled: boolean, revision: number) =>
    disableMock(agent, enabled, revision)
}))

const ID = 'custom-agent:claude:one' as CustomTuiAgentId

beforeEach(() => {
  disableMock.mockReset()
  disableMock.mockResolvedValue({ ok: true, revision: 4 })
  refreshMock.value = []
  ;(window as unknown as { api: unknown }).api = {
    settings: {
      agentCatalog: { referenceSummary: () => Promise.resolve(refreshMock.value) }
    }
  }
})

afterEach(() => cleanup())

function renderDialog(overrides: Partial<Parameters<typeof CustomAgentDisableDialog>[0]> = {}): {
  onDisabled: ReturnType<typeof vi.fn>
  onOpenChange: ReturnType<typeof vi.fn>
} {
  const onDisabled = vi.fn()
  const onOpenChange = vi.fn()
  render(
    <CustomAgentDisableDialog
      open
      agent={{ id: ID, label: 'Nightly Claude' }}
      initialSummary={[{ owner: 'quick-command', count: 2 }]}
      initialRevision={3}
      onOpenChange={onOpenChange}
      onDisabled={onDisabled}
      {...overrides}
    />
  )
  return { onDisabled, onOpenChange }
}

describe('CustomAgentDisableDialog', () => {
  it('names the count, explains consequences, and is not destructive-styled', () => {
    renderDialog()
    expect(screen.getByText('Used by 2 saved items.')).toBeTruthy()
    expect(screen.getByText(/use the stock base agent/i)).toBeTruthy()
    expect(screen.getByText(/session resumes still work/i)).toBeTruthy()
    // Reversible action: default (primary) button, never the destructive variant.
    const button = screen.getByRole('button', { name: 'Disable agent' })
    expect(button.className).not.toContain('bg-destructive')
    expect(button.className).toContain('bg-primary')
  })

  it('disables at the captured revision and closes on success', async () => {
    const { onDisabled, onOpenChange } = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Disable agent' }))
    await waitFor(() => expect(disableMock).toHaveBeenCalledWith(ID, false, 3))
    await waitFor(() => expect(onDisabled).toHaveBeenCalledTimes(1))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('refreshes the count without applying on a revision conflict, then re-confirms', async () => {
    disableMock
      .mockResolvedValueOnce({
        ok: false,
        code: 'catalog_revision_conflict',
        revision: 7,
        snapshot: { revision: 7 }
      })
      .mockResolvedValueOnce({ ok: true, revision: 8 })
    refreshMock.value = [{ owner: 'quick-command', count: 5 }]
    const { onDisabled, onOpenChange } = renderDialog()

    fireEvent.click(screen.getByRole('button', { name: 'Disable agent' }))
    // The conflict path refreshes the count and does not apply/close.
    await waitFor(() => expect(screen.getByText('Used by 5 saved items.')).toBeTruthy())
    expect(onDisabled).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(screen.getByText(/settings changed while this was open/i)).toBeTruthy()

    // Re-confirm now uses the refreshed revision.
    fireEvent.click(screen.getByRole('button', { name: 'Disable agent' }))
    await waitFor(() => expect(disableMock).toHaveBeenLastCalledWith(ID, false, 7))
    await waitFor(() => expect(onDisabled).toHaveBeenCalledTimes(1))
  })

  it('shows an at-least count when an owner store is unreadable', () => {
    renderDialog({ initialSummary: [{ owner: 'session', count: -1 }] })
    expect(screen.getByText('Used by at least 0 saved items.')).toBeTruthy()
  })
})
