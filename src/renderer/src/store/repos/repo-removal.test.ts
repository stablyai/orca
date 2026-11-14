import { afterEach, expect, it, vi } from 'vitest'
import './repo-removal'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  drafts.clearNativeChatComposerDraftsForTests()
  pending.clearNativeChatPendingAttachmentsForTests()
})

import { createTestStore } from '../testing/app-store-test-fixture'
import { makeWorktree } from '../slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from './repo.test-fixture'
import * as drafts from '@/components/native-chat/drafts/native-chat-draft-reset'
import * as draftsOwner1 from '@/components/native-chat/drafts/native-chat-launch-draft-source'
import * as draftsOwner2 from '@/components/native-chat/drafts/native-chat-composer-draft-store'
import * as draftsOwner3 from '@/components/native-chat/drafts/native-chat-composer-draft-memory'
import * as draftsOwner4 from '@/components/native-chat/drafts/native-chat-composer-draft-load'

it('retires a pending launch snapshot only after the real project removal commits', async () => {
  drafts.clearNativeChatComposerDraftsForTests()
  const refused = Promise.withResolvers<void>()
  const remove = vi.fn().mockReturnValueOnce(refused.promise).mockResolvedValue(undefined)
  vi.stubGlobal('window', { api: { repos: { removeForHost: remove }, pty: { kill: vi.fn() } } })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const store = createTestStore()
  store.setState({
    repos: [{ ...TEST_REPO, id: 'repo-1' }],
    worktreesByRepo: {
      'repo-1': [makeWorktree({ id: 'repo-1::/w1', repoId: 'repo-1', hostId: 'local' })]
    }
  })
  const key = draftsOwner1.nativeChatLaunchPromptDraftScopeKey('repo-1::/w1', 'codex', 'local')
  draftsOwner2.updateNativeChatComposerDraft(key, { text: 'project task' }, 'immediate')
  const submission = draftsOwner3.captureNativeChatComposerSubmission(key)
  const removal = store.getState().removeProject('repo-1', { hostId: 'local' })
  await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce())
  store.setState((state) => ({
    worktreesByRepo: {
      'repo-1': [
        ...state.worktreesByRepo['repo-1'],
        makeWorktree({ id: 'repo-1::/w2', repoId: 'repo-1', hostId: 'local' })
      ]
    }
  }))
  const late = draftsOwner1.nativeChatLaunchPromptDraftScopeKey('repo-1::/w2', 'claude', 'local')
  draftsOwner2.updateNativeChatComposerDraft(late, { text: 'late task' }, 'immediate')
  refused.reject(new Error('refused'))
  await removal
  expect(draftsOwner2.readNativeChatComposerDraft(late).text).toBe('late task')
  expect(submission.draft?.text).toBe('project task')
  await store.getState().removeProject('repo-1', { hostId: 'local' })
  expect(remove).toHaveBeenCalledTimes(2)
  expect(draftsOwner2.readNativeChatComposerDraft(late).text).toBe('')
  expect(submission.draft).toBeUndefined()
  expect(draftsOwner2.readNativeChatComposerDraft(key).text).toBe('')
  draftsOwner2.finishNativeChatComposerSubmission(key, submission, true)
  expect(draftsOwner2.readNativeChatComposerDraft(key).text).toBe('')
  drafts.clearNativeChatComposerDraftsForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

import * as pending from '@/components/native-chat/attachments/chips/native-chat-pending-attachment-cache'
import * as persistence from '@/components/native-chat/drafts/native-chat-composer-draft-persistence'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '@/components/native-chat/drafts/native-chat-composer-draft-storage'

it.each([10, 100])(
  'one committed project removal retires current/source-only return writers while preserving ordinary pre-call cleanup at %i owners',
  async (count) => {
    drafts.clearNativeChatComposerDraftsForTests()
    pending.clearNativeChatPendingAttachmentsForTests()
    const remove = Promise.withResolvers<void>()
    const loaded = Promise.withResolvers<ReadonlyMap<string, unknown>>()
    const storage = createMemoryNativeChatComposerDraftStorage()
    storage.loadAll = () => loaded.promise
    setNativeChatComposerDraftStorageForTests(storage)
    const hydration = draftsOwner4.hydrateNativeChatComposerDrafts()
    vi.stubGlobal('window', {
      api: { repos: { removeForHost: vi.fn(() => remove.promise) }, pty: { kill: vi.fn() } }
    })
    const store = createTestStore()
    const first = makeWorktree({ id: 'repo-1::/w0', repoId: 'repo-1', hostId: 'local' })
    store.setState({
      repos: [{ ...TEST_REPO, id: 'repo-1' }],
      worktreesByRepo: { 'repo-1': [first] }
    })
    const removal = store.getState().removeProject('repo-1', { hostId: 'local' })
    await vi.waitFor(() => expect(window.api.repos.removeForHost).toHaveBeenCalledOnce())
    const ids = Array.from({ length: count }, (_, i) => `repo-1::/w${i}`)
    const controls = [
      draftsOwner1.nativeChatLaunchPromptDraftScopeKey(ids[0], 'codex', 'ssh:other'),
      draftsOwner1.nativeChatLaunchPromptDraftScopeKey('other::/live', 'claude', 'local')
    ]
    const snapshots = ids.map((id, i) => {
      const scope = draftsOwner1.nativeChatLaunchPromptDraftScopeKey(id, 'claude', 'local')
      draftsOwner2.updateNativeChatComposerDraft(
        scope,
        { text: `task ${i}`, images: [{ id: `image-${i}`, path: `/image-${i}` }] },
        'immediate'
      )
      const attempt = draftsOwner3.captureNativeChatComposerSubmission(scope)
      const observer = vi.fn()
      const stop = vi.fn(draftsOwner3.subscribeToNativeChatComposerDraftAppend(scope, observer))
      attempt.stopObserving = stop
      if (i % 2) {
        draftsOwner2.updateNativeChatComposerDraft(scope, { text: '', images: [] }, 'immediate')
      }
      const unsubscribe = draftsOwner2.subscribeToNativeChatComposerDraft(scope, vi.fn())
      pending.addNativeChatPendingAttachment(scope, {
        id: `batch-chip-${i}`,
        path: '',
        pending: true
      })
      const pendingListener = vi.fn()
      const unsubscribePending = pending.subscribeToNativeChatPendingAttachments(
        scope,
        pendingListener
      )
      return { scope, attempt, unsubscribe, stop, observer, pendingListener, unsubscribePending }
    })
    const liveAttempts = controls.map((key, i) => {
      draftsOwner2.updateNativeChatComposerDraft(key, { text: 'keep' }, 'immediate')
      pending.addNativeChatPendingAttachment(key, {
        id: `control-chip-${i}`,
        path: '',
        pending: true
      })
      return draftsOwner3.captureNativeChatComposerSubmission(key)
    })
    // W2 arrives during RPC; the final source has no catalog row at all.
    store.setState({
      worktreesByRepo: {
        'repo-1': ids
          .slice(0, -1)
          .map((id) => makeWorktree({ id, repoId: 'repo-1', hostId: 'local' }))
      }
    })
    const visits = { loading: 0, record: 0, listener: 0, submission: 0, pending: 0, chips: 0 }
    const originalLoading = persistence.deleteLoadingNativeChatComposerDraftsWhere
    const originalSubmissions = draftsOwner3.retireNativeChatComposerSubmissionsWhere
    vi.spyOn(draftsOwner3, 'retireNativeChatComposerSubmissionsWhere').mockImplementation((match) =>
      originalSubmissions((...args) => {
        visits.submission++
        return match(...args)
      })
    )
    vi.spyOn(persistence, 'deleteLoadingNativeChatComposerDraftsWhere').mockImplementation(
      (match) =>
        originalLoading((...args) => {
          visits.loading++
          return match(...args)
        })
    )
    const originalMapDelete = Map.prototype.delete
    vi.spyOn(Map.prototype, 'delete').mockImplementation(function (
      this: Map<unknown, unknown>,
      key
    ) {
      if (typeof key === 'string' && key.startsWith('batch-chip-')) {
        visits.chips++
      }
      return originalMapDelete.call(this, key)
    })
    remove.resolve()
    await removal
    const currentVisits = { ...visits }
    process.stdout.write(
      `${JSON.stringify({ metric: 'held-project-commit', count, visits: currentVisits })}\n`
    )
    loaded.resolve(
      new Map(
        ids.map((id) => [
          `loading:${id}`,
          {
            text: 'loaded',
            images: [],
            savedAt: 1,
            owner: { workspaceId: id, executionHostId: 'local' }
          }
        ])
      )
    )
    await hydration
    expect(store.getState().repos.some((repo) => repo.id === 'repo-1')).toBe(false)
    // New writers include W2/source-only scopes; ordinary cleanup still uses pre-call W0.
    expect(persistence.deleteLoadingNativeChatComposerDraftsWhere).toHaveBeenCalledOnce()
    expect(visits.loading).toBe(count)
    expect(currentVisits.submission).toBe(count + 2 * controls.length)
    expect(visits.chips).toBe(1)
    for (const [
      i,
      { scope, attempt, unsubscribe, stop, observer, pendingListener, unsubscribePending }
    ] of snapshots.entries()) {
      expect(attempt.draft).toBeUndefined()
      expect(stop).toHaveBeenCalledOnce()
      expect(pendingListener).toHaveBeenCalledTimes(i === 0 ? 1 : 0)
      expect(observer).not.toHaveBeenCalled()
      expect(draftsOwner2.readNativeChatComposerDraft(scope).text).toBe(
        i === 0 || i % 2 ? '' : `task ${i}`
      )
      expect(pending.nativeChatPendingAttachmentSnapshot(scope)).toHaveLength(i === 0 ? 0 : 1)
      draftsOwner2.finishNativeChatComposerSubmission(scope, attempt, true)
      unsubscribe()
      unsubscribePending()
    }
    expect(draftsOwner2.readNativeChatComposerDraft(`loading:${ids[0]}`).text).toBe('')
    expect(draftsOwner2.readNativeChatComposerDraft(`loading:${ids[1]}`).text).toBe('loaded')
    const freshScope = draftsOwner1.nativeChatLaunchPromptDraftScopeKey(ids[0], 'claude', 'local')
    draftsOwner2.updateNativeChatComposerDraft(freshScope, { text: 'fresh lifetime' }, 'immediate')
    snapshots.forEach(({ scope, attempt }) =>
      draftsOwner2.finishNativeChatComposerSubmission(scope, attempt, true)
    )
    expect(draftsOwner2.readNativeChatComposerDraft(freshScope).text).toBe('fresh lifetime')
    controls.forEach((key, i) => {
      expect(draftsOwner2.readNativeChatComposerDraft(key).text).toBe('keep')
      expect(liveAttempts[i].draft?.text).toBe('keep')
      expect(pending.nativeChatPendingAttachmentSnapshot(key)).toHaveLength(1)
    })
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    drafts.clearNativeChatComposerDraftsForTests()
  }
)
