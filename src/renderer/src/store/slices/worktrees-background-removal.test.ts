import * as launchDrafts from '@/components/native-chat/native-chat-composer-draft-store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'sonner'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { _resetHostWorktreeRemovalsForTests } from './worktrees/teardown/host-worktree-removal-state'
import {
  _resetBackgroundWorktreeRemovalBridgeForTests,
  reconcileHostWorktreeRemovals
} from '../../hooks/ipc-events/background-worktree-removal-bridge'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import '../../components/sidebar/workspace-actions/deletion/worktree-delete-error-display'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn(() => [])
}))

const mockApi = createStoreCascadesMockApi()
const worktreeId = 'repo1::/path/wt1'
const hostKey = getWorktreeHostIdentity({ id: worktreeId, hostId: 'local' })

function seedRow(
  store: ReturnType<typeof createTestStore>,
  overrides: { removing?: true; removalError?: string } = {}
): void {
  seedStore(store, {
    worktreesByRepo: {
      repo1: [
        makeWorktree({
          id: worktreeId,
          repoId: 'repo1',
          path: '/path/wt1',
          hostId: 'local',
          ...overrides
        })
      ]
    }
  })
}

function deleteState(store: ReturnType<typeof createTestStore>) {
  const states = store.getState().deleteStateByWorktreeId
  return states[hostKey] ?? states[worktreeId]
}

describe('removing a worktree the host deletes in the background', () => {
  let store: ReturnType<typeof createTestStore>

  beforeEach(() => {
    vi.clearAllMocks()
    clearRuntimeCompatibilityCacheForTests()
    store = createTestStore()
  })

  afterEach(() => {
    _resetHostWorktreeRemovalsForTests()
    _resetBackgroundWorktreeRemovalBridgeForTests()
  })

  /** Stands in for the listing refresh; `rows` is what the host lists once it lands. */
  function hostListsOnRefresh(rows: 'removed' | 'removing' | 'unmarked' | Error) {
    const refresh = vi.fn()
    refresh.mockImplementation(async () => {
      if (rows instanceof Error) {
        throw rows
      }
      if (rows === 'removed') {
        seedStore(store, { worktreesByRepo: { repo1: [] } })
      } else {
        seedRow(store, rows === 'removing' ? { removing: true } : {})
      }
      return true
    })
    store.setState({ fetchWorktrees: refresh })
    return refresh
  }

  it('finishes a delete whose reply timed out once the host listing drops the row', async () => {
    seedRow(store)
    const refresh = hostListsOnRefresh('removing')
    mockApi.worktrees.remove.mockRejectedValue(new Error('Request timed out: worktree.rm'))
    const removal = store.getState().removeWorktree({ id: worktreeId, executionHostId: null })

    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    expect(deleteState(store)).toMatchObject({ isDeleting: true, error: null })

    seedStore(store, { worktreesByRepo: { repo1: [] } })
    reconcileHostWorktreeRemovals(store)
    await expect(removal).resolves.toEqual({ ok: true })
  })
  it.each(['removed', 'unmarked', 'unreadable'] as const)(
    'lost-reply %s retires only with committed absence proof',
    async (listing) => {
      launchDrafts.clearNativeChatComposerDraftsForTests()
      seedRow(store)
      hostListsOnRefresh(listing === 'unreadable' ? new Error('unreadable') : listing)
      const scope = launchDrafts.nativeChatLaunchPromptDraftScopeKey(worktreeId, 'codex', 'local')
      launchDrafts.updateNativeChatComposerDraft(scope, { text: 'pending task' }, 'immediate')
      const attempt = launchDrafts.captureNativeChatComposerSubmission(scope)
      mockApi.worktrees.remove.mockRejectedValue(new Error('Request timed out: worktree.rm'))
      const result = await store
        .getState()
        .removeWorktree({ id: worktreeId, executionHostId: 'local' })
      expect(result.ok).toBe(listing === 'removed')
      expect(attempt.draft === undefined).toBe(listing === 'removed')
      launchDrafts.clearNativeChatComposerDraftsForTests()
    }
  )
})
