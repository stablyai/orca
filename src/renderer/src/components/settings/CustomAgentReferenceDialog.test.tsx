// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { CustomTuiAgentId } from '../../../../shared/types'
import type { AgentReferenceSummary } from '../../../../shared/agent-reference-snapshot'
import { CustomAgentReferenceDialog } from './CustomAgentReferenceDialog'

const summaryMock = vi.hoisted(() => ({
  value: [] as AgentReferenceSummary[] | null,
  loading: false
}))

vi.mock('./use-agent-reference-summary', () => ({
  useAgentReferenceSummary: () => ({ summary: summaryMock.value, loading: summaryMock.loading })
}))

const ID = 'custom-agent:claude:one' as CustomTuiAgentId

beforeEach(() => {
  summaryMock.value = []
  summaryMock.loading = false
})

afterEach(() => cleanup())

function renderDialog(overrides: Partial<Parameters<typeof CustomAgentReferenceDialog>[0]> = {}): {
  onOpenChange: ReturnType<typeof vi.fn>
} {
  const onOpenChange = vi.fn()
  render(
    <CustomAgentReferenceDialog
      open
      agent={{ id: ID, label: 'Nightly Claude' }}
      deleted
      onOpenChange={onOpenChange}
      {...overrides}
    />
  )
  return { onOpenChange }
}

describe('CustomAgentReferenceDialog', () => {
  it('groups references by name-freeing bucket with per-bucket freeing copy', () => {
    summaryMock.value = [
      { owner: 'default', count: 1 },
      { owner: 'quick-command', count: 2 },
      { owner: 'session', count: 3 },
      { owner: 'background', count: 1 }
    ]
    renderDialog()
    // Rebindable owners promise the name can be freed by reselecting.
    expect(screen.getByText('Can free the name')).toBeTruthy()
    expect(screen.getByText('Open each item and pick another agent to free the name.')).toBeTruthy()
    expect(screen.getByText('Default agent')).toBeTruthy()
    expect(screen.getByText('Quick commands')).toBeTruthy()
    // Retained owners must NOT promise a rebind.
    expect(screen.getByText("Can't be freed yet")).toBeTruthy()
    expect(screen.getByText('Background runs')).toBeTruthy()
  })

  it('shows the deleted framing with the no-undelete statement', () => {
    summaryMock.value = [{ owner: 'quick-command', count: 1 }]
    renderDialog({ deleted: true })
    expect(screen.getByText(/There is no undelete/i)).toBeTruthy()
  })

  it('shows the pre-delete framing when reviewing a live agent', () => {
    summaryMock.value = [{ owner: 'quick-command', count: 1 }]
    renderDialog({ deleted: false })
    expect(screen.getByText(/before you delete it/i)).toBeTruthy()
    expect(screen.queryByText(/There is no undelete/i)).toBeNull()
  })

  it('renders an unreadable owner store as count-unavailable', () => {
    summaryMock.value = [{ owner: 'automation', count: -1 }]
    renderDialog()
    expect(screen.getByText('Automations')).toBeTruthy()
    expect(screen.getByText('Count unavailable')).toBeTruthy()
  })

  it('degrades to a load-failure message when the summary is unavailable', () => {
    summaryMock.value = null
    summaryMock.loading = false
    renderDialog()
    expect(screen.getByText(/References could not be loaded/i)).toBeTruthy()
  })

  it('closes from the footer button', () => {
    const { onOpenChange } = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
