// @vitest-environment happy-dom
//
// The Explorer row decides whether to show the preview action with the hook, and activating it
// runs the plan. The hook used to re-derive that answer from its own copy of the rules; it now
// delegates, and these pin the two to one answer so a future rule change cannot split them.
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  browserAvailability: { state: 'enabled', provider: 'local-client' } as
    | { state: 'enabled'; provider: 'local-client' | 'paired-runtime' }
    | { state: 'hidden'; reason: string },
  environmentId: null as string | null
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/lib/client-creation-action-policy', () => ({
  getClientCreationActionPolicy: () => ({ 'managed-browser': mocks.browserAvailability })
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => mocks.environmentId
}))

const storeState = {
  getKnownWorktreeById: () => ({ id: 'wt-1', path: '/repo' }),
  repos: [{ id: 'repo-1', connectionId: null }],
  worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] }
}

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector(storeState), {
    getState: () => storeState
  })
}))

import {
  canShowWorkspaceFileBrowserAction,
  useWorkspaceFileBrowserActionPredicate
} from './file-preview'

const FILE_PATH = '/repo/report.html'

function predicateAnswer(): boolean {
  return renderHook(() => useWorkspaceFileBrowserActionPredicate('wt-1')).result.current(FILE_PATH)
}

beforeEach(() => {
  mocks.browserAvailability = { state: 'enabled', provider: 'local-client' }
  mocks.environmentId = null
})

describe('workspace file browser action visibility', () => {
  it('agrees with the plan for a local workspace that can open a browser', () => {
    expect(predicateAnswer()).toBe(
      canShowWorkspaceFileBrowserAction(storeState as never, 'wt-1', FILE_PATH)
    )
    expect(predicateAnswer()).toBe(true)
  })

  it('hides the action when the local workspace has no managed browser', () => {
    mocks.browserAvailability = { state: 'hidden', reason: 'browser unavailable' }

    expect(canShowWorkspaceFileBrowserAction(storeState as never, 'wt-1', FILE_PATH)).toBe(false)
    expect(predicateAnswer()).toBe(false)
  })

  it('agrees with the plan on a paired workspace with no managed browser', () => {
    mocks.environmentId = 'env-1'
    mocks.browserAvailability = { state: 'hidden', reason: 'browser unavailable' }

    expect(predicateAnswer()).toBe(
      canShowWorkspaceFileBrowserAction(storeState as never, 'wt-1', FILE_PATH)
    )
    expect(predicateAnswer()).toBe(true)
  })

  it('keeps a stable predicate identity across re-renders of the same workspace', () => {
    const { result, rerender } = renderHook(() => useWorkspaceFileBrowserActionPredicate('wt-1'))
    const first = result.current

    rerender()

    expect(result.current).toBe(first)
  })
})
