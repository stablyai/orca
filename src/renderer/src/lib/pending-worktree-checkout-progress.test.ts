import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CreateWorktreeProgressEvent } from '../../../shared/worktree/create-types'
import {
  getCreationProgressLabel,
  getVisibleCheckoutProgress,
  type PendingWorktreeCreation
} from './pending-worktree-creation'

const { updatePendingWorktreeCreation } = vi.hoisted(() => ({
  updatePendingWorktreeCreation: vi.fn()
}))

vi.mock('../store', () => ({
  useAppStore: { getState: () => ({ updatePendingWorktreeCreation }) }
}))

const checkout = { percent: 42, completed: 420, total: 1000 }

function entry(overrides: Partial<PendingWorktreeCreation>): PendingWorktreeCreation {
  return {
    creationId: 'creation-1',
    phase: 'creating',
    status: 'creating',
    startedAt: 1,
    indeterminate: false,
    loaderVisible: true,
    request: {
      repoId: 'repo-1',
      name: 'feature',
      setupDecision: 'inherit',
      agent: null,
      pendingFirstAgentMessageRename: false,
      note: '',
      startupPlan: null,
      quickPrompt: '',
      quickTelemetry: null
    },
    ...overrides
  }
}

describe('checkout progress on a pending create', () => {
  it('labels a live checkout with its percent', () => {
    const creating = entry({ checkoutProgress: checkout })

    expect(getVisibleCheckoutProgress(creating)).toEqual(checkout)
    expect(getCreationProgressLabel(creating)).toBe('Checking out files… 42%')
  })

  it('keeps the plain label while git has printed no meter', () => {
    expect(getVisibleCheckoutProgress(entry({}))).toBeNull()
    expect(getCreationProgressLabel(entry({}))).toBe('Creating worktree…')
  })

  it('never shows a meter left from an earlier phase or on a failed create', () => {
    const fetching = entry({ phase: 'fetching', checkoutProgress: checkout })
    const failed = entry({ status: 'error', checkoutProgress: checkout })

    expect(getVisibleCheckoutProgress(fetching)).toBeNull()
    expect(getCreationProgressLabel(fetching)).toBe('Fetching base branch…')
    expect(getVisibleCheckoutProgress(failed)).toBeNull()
  })
})

describe('createWorktree:progress bridge', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    updatePendingWorktreeCreation.mockReset()
  })

  async function registerBridge(): Promise<(event: CreateWorktreeProgressEvent) => void> {
    let onCreateProgress: ((event: CreateWorktreeProgressEvent) => void) | undefined
    const subscribe = (): (() => void) => () => {}
    vi.stubGlobal('window', {
      api: {
        repos: { onChanged: subscribe },
        worktrees: {
          onChanged: subscribe,
          onHeadIdentitiesChanged: subscribe,
          onBaseStatus: subscribe,
          onRemoteBranchConflict: subscribe,
          onCreateProgress: (callback: (event: CreateWorktreeProgressEvent) => void) => {
            onCreateProgress = callback
            return () => {}
          }
        }
      }
    })
    const { registerProjectCatalogIpcBridge } =
      await import('../hooks/ipc-events/project-catalog-ipc-bridge')
    registerProjectCatalogIpcBridge(
      [],
      { enqueue: vi.fn(), dispose: vi.fn() },
      () => false,
      () => {}
    )
    expect(onCreateProgress).toBeDefined()
    return (event) => onCreateProgress?.(event)
  }

  it('stores the meter, and clears it when git finishes or the phase changes', async () => {
    const emit = await registerBridge()

    emit({ creationId: 'creation-1', phase: 'creating', checkout })
    emit({ creationId: 'creation-1', phase: 'creating', checkout: null })
    emit({ creationId: 'creation-1', phase: 'fetching' })

    expect(updatePendingWorktreeCreation.mock.calls).toEqual([
      ['creation-1', { phase: 'creating', checkoutProgress: checkout }],
      ['creation-1', { phase: 'creating', checkoutProgress: undefined }],
      ['creation-1', { phase: 'fetching', checkoutProgress: undefined }]
    ])
  })
})
