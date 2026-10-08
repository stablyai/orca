import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repo-types'

type ReadyToast = { title: string; label: ReactNode; onClick: () => void }

const { toasts, store } = vi.hoisted(() => {
  const toasts: ReadyToast[] = []
  const store: { repos: Pick<Repo, 'id' | 'kind'>[] } = { repos: [] }
  return { toasts, store }
})

vi.mock('sonner', () => ({
  toast: {
    success: (title: string, options: { action: { label: ReactNode; onClick: () => void } }) => {
      toasts.push({ title, ...options.action })
    }
  }
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => store }
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn()
}))

import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { showWorktreeCreationReadyToast } from './worktree-creation-ready-toast'

const worktree = {
  id: 'repo-1::/workspace/feature',
  repoId: 'repo-1',
  displayName: 'Feature',
  branch: 'refs/heads/feature',
  path: '/workspace/feature'
}

beforeEach(() => {
  vi.clearAllMocks()
  toasts.length = 0
})

describe('showWorktreeCreationReadyToast', () => {
  it('names a git worktree and offers to go to it', () => {
    store.repos = [{ id: 'repo-1', kind: 'git' }]

    showWorktreeCreationReadyToast(worktree)

    expect(toasts).toHaveLength(1)
    expect(toasts[0]?.title).toBe('Worktree Feature is ready')
    const label = renderToStaticMarkup(<>{toasts[0]?.label}</>)
    expect(label).toContain('lucide-external-link')
    expect(label).toContain('Go to worktree')

    toasts[0]?.onClick()
    expect(activateAndRevealWorktree).toHaveBeenCalledWith(worktree.id, {
      sidebarRevealBehavior: 'auto',
      navigationIntent: 'user-open'
    })
  })

  it('calls a folder repo workspace a workspace, not a worktree', () => {
    store.repos = [{ id: 'repo-1', kind: 'folder' }]

    showWorktreeCreationReadyToast(worktree)

    expect(toasts[0]?.title).toBe('Workspace Feature is ready')
    const label = renderToStaticMarkup(<>{toasts[0]?.label}</>)
    expect(label).toContain('lucide-external-link')
    expect(label).toContain('Go to workspace')
    expect(label).not.toContain('Go to worktree')
  })

  it('keeps the worktree wording when the repo is unknown', () => {
    store.repos = []

    showWorktreeCreationReadyToast(worktree)

    expect(toasts[0]?.title).toBe('Worktree Feature is ready')
    expect(renderToStaticMarkup(<>{toasts[0]?.label}</>)).toContain('Go to worktree')
  })
})
