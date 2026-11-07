// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { makeRepo, makeWorktree } from '../../../worktree-jump/worktree-jump-palette-test-fixtures'
import { SourceControlScopeProvider } from '../panel/worktree-scope'
import { useSourceControlNoteOpening } from './use-note-opening'

const initialAppState = useAppStore.getInitialState()
afterEach(() => {
  cleanup()
  useAppStore.setState(initialAppState, true)
})

it('opens a folder section note in the folder group while the child keeps the content', () => {
  const openFile = vi.fn<AppState['openFile']>(() => 'file')
  useAppStore.setState({
    openFile,
    activeWorktreeId: 'folder:feature',
    activeGroupIdByWorktree: { 'folder:feature': 'folder-group' }
  })
  const worktree = makeWorktree('wt-child', 'wt-child', { instanceId: 'instance-1' })
  const owner = {
    worktreeId: 'wt-child',
    repoId: 'repo-1',
    executionHostId: 'ssh:box' as const,
    worktree,
    attachedAt: 1,
    repo: { ...makeRepo(), connectionId: 'box' },
    placementWorkspaceId: 'folder:feature'
  }
  const { result } = renderHook(
    () =>
      useSourceControlNoteOpening({
        activeWorktreeId: 'wt-child',
        worktreePath: '/tmp/wt-child',
        entries: [],
        branchEntries: [],
        branchSummary: null,
        handleOpenDiff: vi.fn(),
        openCommittedDiff: vi.fn(),
        sourceControlRef: { current: null }
      }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <SourceControlScopeProvider owner={owner}>{children}</SourceControlScopeProvider>
      )
    }
  )

  result.current.handleOpenComment({
    id: 'note-1',
    worktreeId: 'wt-child',
    filePath: 'README.md',
    source: 'markdown',
    lineNumber: 3,
    body: 'check',
    createdAt: 1,
    side: 'modified'
  })

  expect(openFile).toHaveBeenCalledWith(
    expect.objectContaining({ worktreeId: 'wt-child', filePath: '/tmp/wt-child/README.md' }),
    {
      placementWorkspaceId: 'folder:feature',
      executionHostId: 'ssh:box',
      targetGroupId: 'folder-group'
    }
  )
})
