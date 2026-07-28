// @vitest-environment happy-dom

import { act, Suspense } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo, Worktree } from '../../../../shared/types'

const testState = vi.hoisted(() => ({
  activeWorktree: null as Worktree | null,
  repos: [] as Repo[]
}))
const sourceControlModuleLoad = vi.hoisted(() => vi.fn())
const sourceControlMount = vi.hoisted(() => vi.fn(() => <div data-testid="source-control" />))

vi.mock('./SourceControl', () => {
  sourceControlModuleLoad()
  return { default: sourceControlMount }
})

vi.mock('@/store/selectors', () => ({
  useActiveWorktree: () => testState.activeWorktree,
  useRepoById: (repoId: string | null) => testState.repos.find((repo) => repo.id === repoId) ?? null
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import SourceControlGate from './SourceControlGate'

let container: HTMLDivElement
let root: Root

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '#fff',
    addedAt: 1,
    ...overrides
  }
}

function makeWorktree(): Worktree {
  return {
    id: 'repo-1::/repo',
    path: '/repo',
    head: 'abc',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: true,
    repoId: 'repo-1',
    displayName: 'Repo',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

async function renderGate(): Promise<void> {
  await act(async () => {
    root.render(
      <Suspense fallback={null}>
        <SourceControlGate />
      </Suspense>
    )
    await Promise.resolve()
  })
}

describe('SourceControlGate', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    sourceControlModuleLoad.mockClear()
    sourceControlMount.mockClear()
    testState.activeWorktree = null
    testState.repos = []
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  it('shows the no-selection state without loading or mounting Source Control', async () => {
    await renderGate()

    expect(sourceControlModuleLoad).not.toHaveBeenCalled()
    expect(sourceControlMount).not.toHaveBeenCalled()
    expect(container.textContent).toBe('Select a workspace to view changes')
  })

  it('shows the no-selection state for a missing repo without loading Source Control', async () => {
    testState.activeWorktree = makeWorktree()

    await renderGate()

    expect(sourceControlModuleLoad).not.toHaveBeenCalled()
    expect(sourceControlMount).not.toHaveBeenCalled()
    expect(container.textContent).toBe('Select a workspace to view changes')
  })

  it('shows the folder state without loading or mounting Source Control', async () => {
    testState.activeWorktree = makeWorktree()
    testState.repos = [makeRepo({ kind: 'folder' })]

    await renderGate()

    expect(sourceControlModuleLoad).not.toHaveBeenCalled()
    expect(sourceControlMount).not.toHaveBeenCalled()
    expect(container.textContent).toBe('Source Control is only available for Git repositories')
  })

  it('loads and mounts Source Control for legacy git worktrees without a kind', async () => {
    testState.activeWorktree = makeWorktree()
    testState.repos = [makeRepo()]

    await renderGate()

    expect(sourceControlModuleLoad).toHaveBeenCalledOnce()
    expect(sourceControlMount).toHaveBeenCalledOnce()
    expect(container.querySelector('[data-testid="source-control"]')).not.toBeNull()
  })
})
