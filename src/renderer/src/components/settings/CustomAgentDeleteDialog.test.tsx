// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { CustomTuiAgentId } from '../../../../shared/types'
import type { AgentReferenceSummary } from '../../../../shared/agent-reference-snapshot'
import { CustomAgentDeleteDialog } from './CustomAgentDeleteDialog'
import type { DeleteDefaultRecommendation } from './custom-agent-delete-plan'

const deleteMock = vi.hoisted(() =>
  vi.fn<(id: string, onDefault?: string) => Promise<{ ok: boolean; revision: number }>>()
)
const summaryMock = vi.hoisted(() => ({ value: [] as AgentReferenceSummary[] }))

vi.mock('@/lib/agent-catalog-authoring', () => ({
  deleteCustomTuiAgent: (id: string, onDefault?: string) => deleteMock(id, onDefault)
}))

vi.mock('./use-agent-reference-summary', () => ({
  useAgentReferenceSummary: () => ({ summary: summaryMock.value, loading: false })
}))

const ID = 'custom-agent:claude:one' as CustomTuiAgentId
const BASE_LAUNCHABLE: DeleteDefaultRecommendation = {
  recommended: 'base',
  baseLaunchable: true,
  detectionKnown: true
}

beforeEach(() => {
  deleteMock.mockReset()
  deleteMock.mockResolvedValue({ ok: true, revision: 7 })
  summaryMock.value = []
})

afterEach(() => cleanup())

function renderDialog(overrides: Partial<Parameters<typeof CustomAgentDeleteDialog>[0]> = {}): {
  onDeleted: ReturnType<typeof vi.fn>
  onOpenChange: ReturnType<typeof vi.fn>
} {
  const onDeleted = vi.fn()
  const onOpenChange = vi.fn()
  render(
    <CustomAgentDeleteDialog
      open
      agent={{ id: ID, label: 'Nightly Claude', baseAgent: 'claude', isDefault: true }}
      recommendation={BASE_LAUNCHABLE}
      onOpenChange={onOpenChange}
      onDeleted={onDeleted}
      {...overrides}
    />
  )
  return { onDeleted, onOpenChange }
}

describe('CustomAgentDeleteDialog', () => {
  it('states permanent loss and distinct base-global versus stock-fallback copy', () => {
    renderDialog()
    expect(screen.getByText(/can't be undone/i)).toBeTruthy()
    expect(screen.getByText('Open terminals keep running.')).toBeTruthy()
    expect(screen.getByText('Automations and background runs fail until reassigned.')).toBeTruthy()
    // Built-in-global rebind uses the base's own launch fields...
    expect(screen.getByText("Uses Claude's own command, arguments, and environment.")).toBeTruthy()
    // ...while the stock fallback runs only the plain command — distinct copy (Gate G8).
    expect(
      screen.getByText('Launches the plain Claude command with no custom settings.')
    ).toBeTruthy()
  })

  it('pre-selects the launchability-aware recommended outcome', () => {
    renderDialog()
    // Options render base, auto, keep, clear in order; base is recommended here.
    expect(screen.getAllByRole('radio')[0].getAttribute('aria-checked')).toBe('true')
  })

  it('deletes the current default with the recommended base rebind', async () => {
    const { onDeleted } = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Delete agent' }))
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith(ID, 'base'))
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1))
  })

  it('honors a different onDefault choice before deleting', async () => {
    renderDialog()
    fireEvent.click(screen.getByText('Keep a fallback to stock Claude'))
    fireEvent.click(screen.getByRole('button', { name: 'Delete agent' }))
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith(ID, 'keep'))
  })

  it('omits onDefault when the agent is not the current default', async () => {
    renderDialog({
      agent: { id: ID, label: 'Nightly Claude', baseAgent: 'claude', isDefault: false }
    })
    expect(screen.queryByText('This agent is the current default')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Delete agent' }))
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith(ID, undefined))
  })

  it('lists the non-default reference count and opens the review affordance', () => {
    summaryMock.value = [
      { owner: 'default', count: 1 },
      { owner: 'quick-command', count: 2 }
    ]
    const onReviewReferences = vi.fn()
    renderDialog({ onReviewReferences })
    expect(screen.getByText('Used by 2 saved items')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Review references' }))
    expect(onReviewReferences).toHaveBeenCalledTimes(1)
  })
})
