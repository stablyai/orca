// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { BaseDisableImpact } from '../../../../shared/agent-reference-snapshot'
import { BuiltInDisableDialog } from './BuiltInDisableDialog'
import { buildLocalCatalogSnapshot } from './agent-catalog-snapshot.fixture'

type MutationResult =
  | { ok: true; revision: number }
  | { ok: false; code: string; revision: number; snapshot?: unknown }

const disableMock = vi.hoisted(() =>
  vi.fn<(agent: string, enabled: boolean, revision: number) => Promise<MutationResult>>()
)
const impactMock = vi.hoisted(() => ({
  value: {
    savedReferences: { count: 0, atLeast: false },
    resumableSessions: { count: 0, atLeast: false }
  } as BaseDisableImpact
}))

vi.mock('@/lib/agent-catalog-authoring', () => ({
  setTuiAgentEnabledAtRevision: (agent: string, enabled: boolean, revision: number) =>
    disableMock(agent, enabled, revision)
}))

const IMPACT: BaseDisableImpact = {
  savedReferences: { count: 3, atLeast: false },
  resumableSessions: { count: 2, atLeast: false }
}

beforeEach(() => {
  disableMock.mockReset()
  disableMock.mockResolvedValue({ ok: true, revision: 6 })
  impactMock.value = {
    savedReferences: { count: 9, atLeast: false },
    resumableSessions: { count: 0, atLeast: false }
  }
  ;(window as unknown as { api: unknown }).api = {
    settings: {
      agentCatalog: {
        baseDisableImpact: () => Promise.resolve(impactMock.value),
        getLocal: () => Promise.resolve(buildLocalCatalogSnapshot({ revision: 7 }))
      }
    }
  }
})

afterEach(() => cleanup())

function renderDialog(overrides: Partial<Parameters<typeof BuiltInDisableDialog>[0]> = {}): {
  onDisabled: ReturnType<typeof vi.fn>
  onOpenChange: ReturnType<typeof vi.fn>
} {
  const onDisabled = vi.fn()
  const onOpenChange = vi.fn()
  render(
    <BuiltInDisableDialog
      open
      base="claude"
      baseLabel="Claude"
      initialEnabledDerivatives={2}
      initialImpact={IMPACT}
      initialRevision={5}
      onOpenChange={onOpenChange}
      onDisabled={onDisabled}
      {...overrides}
    />
  )
  return { onDisabled, onOpenChange }
}

describe('BuiltInDisableDialog', () => {
  it('names the three affected counts and the blocking consequence', () => {
    renderDialog()
    expect(screen.getByText(/every new launch on Claude/i)).toBeTruthy()
    expect(screen.getByText('2 enabled custom agents built on it')).toBeTruthy()
    expect(screen.getByText('Used by 3 saved items (including its custom agents)')).toBeTruthy()
    expect(screen.getByText('2 resumable sessions')).toBeTruthy()
    // Reversible: primary button, not destructive.
    const button = screen.getByRole('button', { name: 'Disable agent' })
    expect(button.className).not.toContain('bg-destructive')
  })

  it('omits count rows that are zero', () => {
    renderDialog({
      initialEnabledDerivatives: 0,
      initialImpact: {
        savedReferences: { count: 1, atLeast: false },
        resumableSessions: { count: 0, atLeast: false }
      }
    })
    expect(screen.queryByText(/enabled custom agents/i)).toBeNull()
    expect(screen.queryByText(/resumable sessions/i)).toBeNull()
    expect(screen.getByText('Used by 1 saved items (including its custom agents)')).toBeTruthy()
  })

  it('disables the base at the captured revision and closes on success', async () => {
    const { onDisabled, onOpenChange } = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Disable agent' }))
    await waitFor(() => expect(disableMock).toHaveBeenCalledWith('claude', false, 5))
    await waitFor(() => expect(onDisabled).toHaveBeenCalledTimes(1))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('refreshes the counts without applying on a revision conflict', async () => {
    disableMock
      .mockResolvedValueOnce({
        ok: false,
        code: 'catalog_revision_conflict',
        revision: 8,
        snapshot: buildLocalCatalogSnapshot({ revision: 8 })
      })
      .mockResolvedValueOnce({ ok: true, revision: 9 })
    const { onDisabled } = renderDialog()

    fireEvent.click(screen.getByRole('button', { name: 'Disable agent' }))
    // Host impact refresh returns 9 saved references; not applied/closed yet.
    await waitFor(() =>
      expect(screen.getByText('Used by 9 saved items (including its custom agents)')).toBeTruthy()
    )
    expect(onDisabled).not.toHaveBeenCalled()
    expect(screen.getByText(/settings changed while this was open/i)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Disable agent' }))
    await waitFor(() => expect(disableMock).toHaveBeenLastCalledWith('claude', false, 8))
    await waitFor(() => expect(onDisabled).toHaveBeenCalledTimes(1))
  })

  it('shows an at-least count when an owner store is unreadable', () => {
    renderDialog({
      initialEnabledDerivatives: 0,
      initialImpact: {
        savedReferences: { count: 4, atLeast: true },
        resumableSessions: { count: 0, atLeast: false }
      }
    })
    expect(
      screen.getByText('Used by at least 4 saved items (including its custom agents)')
    ).toBeTruthy()
  })
})
