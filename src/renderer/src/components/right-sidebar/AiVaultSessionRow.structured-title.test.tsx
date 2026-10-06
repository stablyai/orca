// @vitest-environment happy-dom

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { VaultSessionRow } from './AiVaultSessionRow'
import { session, tab } from './ai-vault-structured-title-fixtures'

const initialState = useAppStore.getInitialState()

function renderRow(row: AiVaultSession): void {
  render(
    <TooltipProvider>
      <VaultSessionRow
        session={row}
        liveState={null}
        resumeStartup={{ command: row.resumeCommand }}
        realHomeResumeStartup={{ command: row.resumeCommand }}
        worktreeInfo={null}
        vaultScope="all"
        detailsExpanded={false}
        resumeDisabled={false}
        onToggleDetails={vi.fn()}
        showJumpToWorktree={false}
        onResume={vi.fn()}
        resumeLabel="Resume"
        resumeActions={{
          worktree: { worktreeId: null, disabled: true },
          newTab: { worktreeId: null, disabled: true }
        }}
        onResumeInWorktree={vi.fn()}
        onResumeInNewTab={vi.fn()}
        onCopyId={vi.fn()}
        onCopyPath={vi.fn()}
      />
    </TooltipProvider>
  )
}

beforeEach(() => useAppStore.setState(initialState, true))
afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
})

describe('rendered native Vault titles', () => {
  it.each([tab('Other host', 'runtime:other-host'), tab('Other provider', 'local', 'claude')])(
    'does not display a colliding tab title from $label',
    (other) => {
      useAppStore.setState({ unifiedTabsByWorktree: { 'folder-workspace': [other] } })
      renderRow(session())
      expect(screen.getByText('Codex Chat')).toBeTruthy()
      expect(screen.queryByText(other.label)).toBeNull()
    }
  )

  it('keeps the ordinary live label ahead of an older host provider title', () => {
    useAppStore.setState({ unifiedTabsByWorktree: { 'folder-workspace': [tab()] } })
    renderRow({ ...session(), title: 'Saved conversation name' })
    expect(screen.getByText('Codex Chat')).toBeTruthy()
    expect(screen.queryByText('Saved conversation name')).toBeNull()
  })

  it('keeps manual rename priority and restores the saved name when cleared or closed', () => {
    useAppStore.setState({
      unifiedTabsByWorktree: {
        'folder-workspace': [{ ...tab('Generated name'), customLabel: 'Manual name' }]
      }
    })
    renderRow({ ...session(), title: 'Generated name' })
    expect(screen.getByText('Manual name')).toBeTruthy()
    act(() =>
      useAppStore.setState({
        unifiedTabsByWorktree: { 'folder-workspace': [tab('Generated name')] }
      })
    )
    expect(screen.getByText('Generated name')).toBeTruthy()
    act(() => useAppStore.setState({ unifiedTabsByWorktree: {} }))
    expect(screen.getByText('Generated name')).toBeTruthy()
  })
})
