import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  createWorktreeEventRuntime,
  recentlyRenamedWorktreeIdExpiry
} from './worktree-event-runtime'

const { activateAndRevealWorktree } = vi.hoisted(() => ({
  activateAndRevealWorktree: vi.fn()
}))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree }))

const initialState = useAppStore.getState()
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  useAppStore.setState(initialState, true)
  vi.clearAllMocks()
})

it.each([false, true])(
  'keeps async activation tied to its publishing connection (current=%s)',
  async (stillCurrent) => {
    const fetched = Promise.withResolvers<void>()
    const fetchWorktrees = vi.spyOn(initialState, 'fetchWorktrees').mockImplementation(async () => {
      await fetched.promise
      return false
    })
    useAppStore.setState({
      fetchWorktrees: initialState.fetchWorktrees,
      getKnownWorktreeById: vi.fn(() => undefined)
    })
    const unsubs: (() => void)[] = []
    const runtime = createWorktreeEventRuntime(unsubs, () => false)
    let current = true
    try {
      const activation = runtime.activateNotifiedWorktree(
        { type: 'activateWorktree', repoId: 'same-repo', worktreeId: 'same-wt', navigation: 'all' },
        {
          allowRuntimeEnvironment: true,
          executionHostId: 'runtime:host-a',
          isCurrent: () => current
        }
      )
      expect(fetchWorktrees).toHaveBeenCalledWith('same-repo', {
        executionHostId: 'runtime:host-a'
      })
      current = stillCurrent
      fetched.resolve()
      await activation
      if (stillCurrent) {
        expect(activateAndRevealWorktree).toHaveBeenCalledWith('same-wt', {
          executionHostId: 'runtime:host-a',
          notifyHostRuntime: false
        })
        // A CLI or agent switch is not the user's: it must not let a remount start a stopped distro.
        expect(vi.mocked(activateAndRevealWorktree).mock.calls[0]?.[1]).not.toHaveProperty(
          'navigationIntent'
        )
      } else {
        expect(activateAndRevealWorktree).not.toHaveBeenCalled()
      }
    } finally {
      fetched.resolve()
      unsubs.forEach((unsubscribe) => unsubscribe())
    }
  }
)

it('the actual rename event protects both identities before starting discovery', async () => {
  recentlyRenamedWorktreeIdExpiry.clear()
  const unsubs: (() => void)[] = []
  useAppStore.setState({
    fetchWorktrees: vi.fn(async () => {
      expect(recentlyRenamedWorktreeIdExpiry.has('repo::/old')).toBe(true)
      expect(recentlyRenamedWorktreeIdExpiry.has('repo::/new')).toBe(true)
      return false
    }),
    fetchWorktreeLineage: vi.fn(),
    migrateWorktreeIdentity: vi.fn()
  })
  const runtime = createWorktreeEventRuntime(unsubs, () => false)
  runtime.worktreeChangeRefreshQueue.enqueue({
    repoId: 'repo',
    executionHostId: 'local',
    renamed: { oldWorktreeId: 'repo::/old', newWorktreeId: 'repo::/new' }
  })
  await vi.waitFor(() => expect(useAppStore.getState().fetchWorktrees).toHaveBeenCalledOnce())
  unsubs.forEach((unsubscribe) => unsubscribe())
  recentlyRenamedWorktreeIdExpiry.clear()
})

import * as drafts from '@/components/native-chat/native-chat-composer-draft-store'
import { TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
it('the conditionally installed qualified rename keeps ordinary setup content and other-host input', async () => {
  drafts.clearNativeChatComposerDraftsForTests()
  const from = drafts.nativeChatLaunchPromptDraftScopeKey('repo::/old', 'claude', 'local')
  const twin = drafts.nativeChatLaunchPromptDraftScopeKey('repo::/old', 'claude', 'runtime:other')
  drafts.updateNativeChatComposerDraft(from, { text: 'moving' }, 'immediate')
  drafts.updateNativeChatComposerDraft(twin, { text: 'twin' }, 'immediate')
  const fetched = Promise.withResolvers<void>()
  useAppStore.setState({
    repos: [{ ...TEST_REPO, id: 'repo' }],
    fetchWorktrees: vi.fn(async () => {
      fetched.resolve()
      return false
    }),
    migrateWorktreeIdentity: vi.fn()
  })
  const unsubs: (() => void)[] = []
  const runtime = createWorktreeEventRuntime(unsubs, () => false)
  runtime.worktreeChangeRefreshQueue.enqueue({
    repoId: 'repo',
    forceLocalOwner: true,
    renamed: { oldWorktreeId: 'repo::/old', newWorktreeId: 'repo::/new' }
  })
  await fetched.promise
  expect(
    drafts.readNativeChatComposerDraft(
      drafts.nativeChatLaunchPromptDraftScopeKey('repo::/new', 'claude', 'local')
    ).text
  ).toBe('moving')
  expect(drafts.readNativeChatComposerDraft(twin).text).toBe('twin')
  unsubs.forEach((unsubscribe) => unsubscribe())
  drafts.clearNativeChatComposerDraftsForTests()
  recentlyRenamedWorktreeIdExpiry.clear()
})
