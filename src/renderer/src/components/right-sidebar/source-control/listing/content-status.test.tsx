// @vitest-environment happy-dom

import React from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StoppedWslHost } from '../../../wsl-host-stopped/use-stopped-wsl-host'
import { SourceControlContentStatus } from './content-status'

const { stoppedHost, startHost } = vi.hoisted(() => {
  const stoppedHost: { current: StoppedWslHost | null } = { current: null }
  return {
    stoppedHost,
    startHost: vi.fn<(environmentId: string) => Promise<boolean>>()
  }
})

vi.mock('../../../wsl-host-stopped/use-stopped-wsl-host', () => ({
  useStoppedWslHost: () => stoppedHost.current
}))
vi.mock('@/lib/wsl-host-user-start', () => ({
  startWslHostAndReloadProjects: startHost
}))

function statusProps(): React.ComponentProps<typeof SourceControlContentStatus> {
  return {
    unresolvedConflictCount: 0,
    conflictOperation: 'rebase',
    sourceControlAiActionsVisible: true,
    isRecoveryBusy: false,
    isAbortingOperation: false,
    onAbortOperation: vi.fn(),
    isCompletingMerge: false,
    onCompleteMerge: vi.fn(),
    onResolveWithAi: vi.fn(),
    onReviewConflicts: vi.fn(),
    repositoryHuge: null,
    worktreeId: 'wt-1',
    onRetryStatus: vi.fn(),
    onStageAllChanges: vi.fn(),
    isExecutingBulk: false,
    showGenericEmptyState: false,
    normalizedFilter: '',
    branchBaseRef: 'main',
    filterTooLarge: false,
    hasFilteredUncommittedEntries: false,
    hasFilteredBranchEntries: false,
    filterQuery: ''
  }
}

afterEach(cleanup)

describe('SourceControlContentStatus recovery', () => {
  it.each([0, 1])(
    'blocks recovery while Git runs with %i unmerged paths',
    (unresolvedConflictCount) => {
      const props = { ...statusProps(), unresolvedConflictCount, isRecoveryBusy: true }
      const view = render(<SourceControlContentStatus {...props} />)
      const button = view.getByRole('button', { name: 'Resolve with AI' })
      expect(button.hasAttribute('disabled')).toBe(true)
      fireEvent.click(button)
      expect(props.onResolveWithAi).not.toHaveBeenCalled()

      view.rerender(<SourceControlContentStatus {...props} isRecoveryBusy={false} />)
      expect(button.hasAttribute('disabled')).toBe(false)
      fireEvent.click(button)
      expect(props.onResolveWithAi).toHaveBeenCalledTimes(1)
    }
  )

  it.each([0, 1])(
    'blocks recovery during abort with %i unmerged paths',
    (unresolvedConflictCount) => {
      const props = { ...statusProps(), unresolvedConflictCount, isAbortingOperation: true }
      const view = render(<SourceControlContentStatus {...props} />)
      const button = view.getByRole('button', { name: 'Resolve with AI' })
      fireEvent.click(button)
      expect(button.hasAttribute('disabled')).toBe(true)
      expect(props.onResolveWithAi).not.toHaveBeenCalled()
    }
  )
})

describe('SourceControlContentStatus on a stopped WSL host', () => {
  afterEach(() => {
    stoppedHost.current = null
    startHost.mockReset()
  })

  it('offers Start in place of the read error and the clean state', () => {
    stoppedHost.current = { environmentId: 'wsl:ubuntu', distro: 'Ubuntu' }
    startHost.mockResolvedValue(true)
    const props = {
      ...statusProps(),
      statusReadError: "The server isn't answering",
      showGenericEmptyState: true
    }
    const view = render(<SourceControlContentStatus {...props} />)
    expect(view.getByText('Ubuntu is stopped')).toBeTruthy()
    expect(view.queryByText(/Git could not read this workspace/)).toBeNull()
    expect(view.queryByText('No changes on this branch')).toBeNull()
    expect(startHost).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: 'Start' }))
    expect(startHost).toHaveBeenCalledWith('wsl:ubuntu')
  })

  it('keeps the read error when the host is not stopped', () => {
    const props = {
      ...statusProps(),
      statusReadError: 'fatal: not a git repository'
    }
    const view = render(<SourceControlContentStatus {...props} />)
    expect(view.getByText(/Git could not read this workspace/)).toBeTruthy()
    expect(view.queryByRole('button', { name: 'Start' })).toBeNull()
  })
})
