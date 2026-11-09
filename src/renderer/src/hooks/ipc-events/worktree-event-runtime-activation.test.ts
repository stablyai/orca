import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  createWorktreeEventRuntime,
  recentlyRenamedWorktreeIdExpiry
} from './worktree-event-runtime'

const { activateAndRevealWorktree } = vi.hoisted(() => ({
  activateAndRevealWorktree: vi.fn()
}))
vi.mock('@/lib/workspace/activation/worktree-activation', () => ({ activateAndRevealWorktree }))

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

import * as drafts from '@/components/native-chat/drafts/native-chat-draft-reset'
import * as draftsOwner1 from '@/components/native-chat/drafts/native-chat-launch-draft-source'
import * as draftsOwner2 from '@/components/native-chat/drafts/native-chat-composer-draft-store'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
it('the conditionally installed qualified rename keeps ordinary setup content and other-host input', async () => {
  drafts.clearNativeChatComposerDraftsForTests()
  const from = draftsOwner1.nativeChatLaunchPromptDraftScopeKey('repo::/old', 'claude', 'local')
  const twin = draftsOwner1.nativeChatLaunchPromptDraftScopeKey(
    'repo::/old',
    'claude',
    'runtime:other'
  )
  draftsOwner2.updateNativeChatComposerDraft(from, { text: 'moving' }, 'immediate')
  draftsOwner2.updateNativeChatComposerDraft(twin, { text: 'twin' }, 'immediate')
  const fetched = Promise.withResolvers<void>()
  vi.spyOn(initialState, 'fetchWorktrees').mockImplementation(async () => {
    fetched.resolve()
    return false
  })
  useAppStore.setState({
    repos: [{ ...TEST_REPO, id: 'repo' }],
    fetchWorktrees: initialState.fetchWorktrees,
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
    draftsOwner2.readNativeChatComposerDraft(
      draftsOwner1.nativeChatLaunchPromptDraftScopeKey('repo::/new', 'claude', 'local')
    ).text
  ).toBe('moving')
  expect(draftsOwner2.readNativeChatComposerDraft(twin).text).toBe('twin')
  unsubs.forEach((unsubscribe) => unsubscribe())
  drafts.clearNativeChatComposerDraftsForTests()
  recentlyRenamedWorktreeIdExpiry.clear()
})
