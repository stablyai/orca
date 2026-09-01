// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CustomAgentRepairDialog } from './CustomAgentRepairDialog'
import type { AgentCatalogMutation } from '../../../../shared/agent-catalog-snapshot'

const mutateMock = vi.hoisted(() =>
  vi.fn<(mutation: AgentCatalogMutation) => Promise<{ ok: boolean; revision: number }>>()
)

vi.mock('@/lib/agent-catalog-authoring', () => ({
  mutateAgentCatalog: (mutation: AgentCatalogMutation) => mutateMock(mutation)
}))

beforeEach(() => {
  mutateMock.mockReset()
  mutateMock.mockResolvedValue({ ok: true, revision: 3 })
})

afterEach(() => cleanup())

function renderDialog(overrides: Partial<Parameters<typeof CustomAgentRepairDialog>[0]> = {}): {
  onReplaceAsNew: ReturnType<typeof vi.fn>
  onDiscarded: ReturnType<typeof vi.fn>
} {
  const onReplaceAsNew = vi.fn()
  const onDiscarded = vi.fn()
  render(
    <CustomAgentRepairDialog
      open
      target={{ repairToken: 'tok-1', label: 'Broken One' }}
      onOpenChange={vi.fn()}
      onReplaceAsNew={onReplaceAsNew}
      onDiscarded={onDiscarded}
      {...overrides}
    />
  )
  return { onReplaceAsNew, onDiscarded }
}

describe('CustomAgentRepairDialog', () => {
  it('hands off to the replace-as-new editor without mutating', () => {
    const { onReplaceAsNew } = renderDialog()
    fireEvent.click(screen.getByText('Replace as new agent'))
    expect(onReplaceAsNew).toHaveBeenCalledTimes(1)
    expect(mutateMock).not.toHaveBeenCalled()
  })

  it('discards the corrupt row through repair-corrupt/discard by token', async () => {
    const { onDiscarded } = renderDialog()
    fireEvent.click(screen.getByText('Discard corrupt row'))
    await waitFor(() => expect(onDiscarded).toHaveBeenCalledTimes(1))
    expect(mutateMock).toHaveBeenCalledWith({
      kind: 'repair-corrupt',
      repairToken: 'tok-1',
      action: { kind: 'discard' }
    })
  })

  it('surfaces an error and keeps the dialog open when discard fails', async () => {
    mutateMock.mockResolvedValue({ ok: false, revision: 3 })
    const { onDiscarded } = renderDialog()
    fireEvent.click(screen.getByText('Discard corrupt row'))
    await waitFor(() => expect(screen.getByText(/Could not discard/)).toBeTruthy())
    expect(onDiscarded).not.toHaveBeenCalled()
  })

  it('names the group generically when the label is unsafe', () => {
    renderDialog({ target: { repairToken: 'tok-2', label: null } })
    expect(screen.getByText(/Repair this custom agent/)).toBeTruthy()
  })
})
