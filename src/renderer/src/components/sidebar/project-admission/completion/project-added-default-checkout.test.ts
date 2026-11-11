import { expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../../../shared/worktree/types'

vi.mock('@/store/index', () => ({ useAppStore: {} }))
vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn()
}))
vi.mock('@/diagnostics/telemetry/telemetry', () => ({ track: vi.fn() }))
vi.mock('@/components/onboarding/onboarding-project-checklist', () => ({
  markOnboardingProjectAdded: vi.fn()
}))
const { getProjectDefaultCheckout } = await import('./project-added-default-checkout')

function row(path: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: `r::${path}`,
    repoId: 'r',
    path,
    head: 'abc',
    branch: '',
    isBare: false,
    isMainWorktree: false,
    displayName: path,
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
    lastActivityAt: 0,
    ...overrides
  }
}

it('opens a real checkout for bare layouts and honors the checkout the user opened', () => {
  const bare = row('/project/.bare', { isBare: true, isMainWorktree: true })
  const main = row('/project/main')
  const opened = row('/project/feature')
  expect(getProjectDefaultCheckout([bare, main, opened])?.path).toBe('/project/main')
  expect(getProjectDefaultCheckout([bare, main, opened], '/project/feature/src')?.path).toBe(
    '/project/feature'
  )
  expect(getProjectDefaultCheckout([bare])).toBeNull()
})

it('keeps a regular checkout with separate Git storage as the default', () => {
  const main = row('/project/main', { isMainWorktree: true })
  expect(getProjectDefaultCheckout([row('/project/feature'), main])?.path).toBe('/project/main')
})
