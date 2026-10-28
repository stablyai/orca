// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { MultiRepoMember } from '../../../../shared/multi-repo-workspace'
import type { Repo } from '../../../../shared/repo-types'
import MultiRepoRowBadge from './MultiRepoRowBadge'

function member(id: string, patch: Partial<MultiRepoMember> = {}): MultiRepoMember {
  return {
    memberId: id,
    repoId: `repo-${id}`,
    dirName: id,
    branchName: 'flow',
    state: 'ready',
    attempts: 1,
    worktreeId: `wt-${id}`,
    ...patch
  }
}

function workspace(members: MultiRepoMember[] | null): FolderWorkspace {
  return {
    id: 'f1',
    projectGroupId: 'g1',
    name: 'checkout-flow',
    folderPath: '/w/f1',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0,
    ...(members
      ? { multiRepo: { version: 1, executionHostId: 'local', rootOwnedByOrca: true, members } }
      : {})
  }
}

beforeEach(() => {
  useAppStore.setState({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the badge reads only repo ids and names.
    repos: ['a', 'b', 'c'].map((id) => ({ id: `repo-${id}`, displayName: id }) as Repo),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: minimal worktree fixtures; the badge reads only id.
    worktreesByRepo: {
      'repo-a': [{ id: 'wt-a' }],
      'repo-b': [{ id: 'wt-b' }],
      'repo-c': [{ id: 'wt-c' }]
    } as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the status map is only counted, never read by entry shape.
    gitStatusByWorktree: { 'wt-a': [{}, {}], 'wt-b': [{}] } as never
  })
})

afterEach(cleanup)

describe('MultiRepoRowBadge', () => {
  it('shows the repo count and the aggregate change count', () => {
    const { container } = render(
      <MultiRepoRowBadge folderWorkspace={workspace([member('a'), member('b'), member('c')])} />
    )
    expect(container.textContent).toContain('3 changed')
    expect(container.textContent).toContain('3 repos')
  })

  it('spells out a failure and progress in words, never a bare dot', () => {
    const { container, rerender } = render(
      <MultiRepoRowBadge
        folderWorkspace={workspace([
          member('a'),
          member('b', { state: 'failed', worktreeId: undefined }),
          member('c')
        ])}
      />
    )
    expect(container.textContent).toContain('3 repos · 1 failed')
    rerender(
      <MultiRepoRowBadge
        folderWorkspace={workspace([
          member('a'),
          member('b', { state: 'creating', worktreeId: undefined }),
          member('c', { state: 'queued', worktreeId: undefined })
        ])}
      />
    )
    expect(container.textContent).toContain('Creating 1/3')
  })

  it('renders nothing for a plain folder workspace', () => {
    const { container } = render(<MultiRepoRowBadge folderWorkspace={workspace(null)} />)
    expect(container.firstChild).toBeNull()
  })
})
