import { afterEach, describe, expect, it } from 'vitest'
import { countOpenRepoTerminalTabs } from './repo-removal'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  drafts.clearNativeChatComposerDraftsForTests()
  pending.clearNativeChatPendingAttachmentsForTests()
})

describe('countOpenRepoTerminalTabs', () => {
  it('counts tabs with a PTY on the removed host only', () => {
    const state = {
      worktreesByRepo: {
        'repo-1': [
          { id: 'repo-1::/a', hostId: 'local' },
          { id: 'repo-1::/srv/a', hostId: 'ssh:box' }
        ]
      },
      detectedWorktreesByRepo: {},
      tabsByWorktree: {
        'repo-1::/a': [{ id: 'tab-live' }, { id: 'tab-no-pty' }],
        'repo-1::/srv/a': [{ id: 'tab-ssh' }]
      },
      ptyIdsByTabId: { 'tab-live': ['pty-1'], 'tab-no-pty': [], 'tab-ssh': ['pty-2'] }
    }

    expect(countOpenRepoTerminalTabs(state, 'repo-1', 'local')).toBe(1)
    expect(countOpenRepoTerminalTabs(state, 'repo-1', 'ssh:box')).toBe(1)
    expect(countOpenRepoTerminalTabs(state, 'repo-2', 'local')).toBe(0)
  })
})

import { vi } from 'vitest'
import { createTestStore, makeWorktree, TEST_REPO } from '../slices/store-test-helpers'
import * as drafts from '@/components/native-chat/native-chat-composer-draft-store'

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
  const key = drafts.nativeChatLaunchPromptDraftScopeKey('repo-1::/w1', 'codex', 'local')
  drafts.updateNativeChatComposerDraft(key, { text: 'project task' }, 'immediate')
  const submission = drafts.captureNativeChatComposerSubmission(key)
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
  const late = drafts.nativeChatLaunchPromptDraftScopeKey('repo-1::/w2', 'claude', 'local')
  drafts.updateNativeChatComposerDraft(late, { text: 'late task' }, 'immediate')
  refused.reject(new Error('refused'))
  await removal
  expect(drafts.readNativeChatComposerDraft(late).text).toBe('late task')
  expect(submission.draft?.text).toBe('project task')
  await store.getState().removeProject('repo-1', { hostId: 'local' })
  expect(remove).toHaveBeenCalledTimes(2)
  expect(drafts.readNativeChatComposerDraft(late).text).toBe('')
  expect(submission.draft).toBeUndefined()
  expect(drafts.readNativeChatComposerDraft(key).text).toBe('')
  drafts.finishNativeChatComposerSubmission(key, submission, true)
  expect(drafts.readNativeChatComposerDraft(key).text).toBe('')
  drafts.clearNativeChatComposerDraftsForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

import * as memory from '@/components/native-chat/native-chat-composer-draft-memory'
import * as pending from '@/components/native-chat/native-chat-pending-attachment-cache'
import * as persistence from '@/components/native-chat/native-chat-composer-draft-persistence'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '@/components/native-chat/native-chat-composer-draft-storage'

it.each([10, 100])(
  'one committed project removal retires current/source-only launch resources in bounded passes at %i owners',
  async (count) => {
    drafts.clearNativeChatComposerDraftsForTests()
    pending.clearNativeChatPendingAttachmentsForTests()
    const remove = Promise.withResolvers<void>()
    const loaded = Promise.withResolvers<ReadonlyMap<string, unknown>>()
    const storage = createMemoryNativeChatComposerDraftStorage()
    storage.loadAll = () => loaded.promise
    setNativeChatComposerDraftStorageForTests(storage)
    const hydration = drafts.hydrateNativeChatComposerDrafts()
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
      drafts.nativeChatLaunchPromptDraftScopeKey(ids[0], 'codex', 'ssh:other'),
      drafts.nativeChatLaunchPromptDraftScopeKey('other::/live', 'claude', 'local')
    ]
    const snapshots = ids.map((id, i) => {
      const scope = drafts.nativeChatLaunchPromptDraftScopeKey(id, 'claude', 'local')
      drafts.updateNativeChatComposerDraft(
        scope,
        { text: `task ${i}`, images: [{ id: `image-${i}`, path: `/image-${i}` }] },
        'immediate'
      )
      const attempt = drafts.captureNativeChatComposerSubmission(scope)
      const observer = vi.fn()
      const stop = vi.fn(memory.subscribeToNativeChatComposerDraftAppend(scope, observer))
      attempt.stopObserving = stop
      if (i % 2) {
        drafts.updateNativeChatComposerDraft(scope, { text: '', images: [] }, 'immediate')
      }
      const unsubscribe = drafts.subscribeToNativeChatComposerDraft(scope, vi.fn())
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
      drafts.updateNativeChatComposerDraft(key, { text: 'keep' }, 'immediate')
      pending.addNativeChatPendingAttachment(key, {
        id: `control-chip-${i}`,
        path: '',
        pending: true
      })
      return drafts.captureNativeChatComposerSubmission(key)
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
    const originalDelete = drafts.deleteNativeChatComposerDraftsWhere
    const originalLoading = persistence.deleteLoadingNativeChatComposerDraftsWhere
    const originalPending = pending.dropNativeChatPendingAttachmentsWhere
    vi.spyOn(persistence, 'deleteLoadingNativeChatComposerDraftsWhere').mockImplementation(
      (match) =>
        originalLoading((...args) => {
          visits.loading++
          return match(...args)
        })
    )
    vi.spyOn(drafts, 'deleteNativeChatComposerDraftsWhere').mockImplementation((match, retire) =>
      originalDelete((key, draft) => {
        visits[draft ? (draft.savedAt === 0 ? 'submission' : 'record') : 'listener']++
        return match(key, draft)
      }, retire)
    )
    vi.spyOn(pending, 'dropNativeChatPendingAttachmentsWhere').mockImplementation((match) =>
      originalPending((...args) => {
        visits.pending++
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
    expect(drafts.deleteNativeChatComposerDraftsWhere).toHaveBeenCalledOnce()
    expect(pending.dropNativeChatPendingAttachmentsWhere).toHaveBeenCalledOnce()
    expect(persistence.deleteLoadingNativeChatComposerDraftsWhere).toHaveBeenCalledOnce()
    expect(visits.loading).toBe(count)
    expect(visits.submission).toBe(count + controls.length)
    expect(currentVisits.record).toBeLessThanOrEqual(count + 2)
    expect(currentVisits.listener).toBeLessThanOrEqual(count + 2)
    expect(visits.pending).toBe(count + controls.length)
    expect(visits.chips).toBe(count)
    expect(memory.scopeListeners.size).toBe(0)
    for (const [
      i,
      { scope, attempt, unsubscribe, stop, observer, pendingListener, unsubscribePending }
    ] of snapshots.entries()) {
      expect(attempt.draft).toBeUndefined()
      expect(stop).toHaveBeenCalledOnce()
      expect(pendingListener).toHaveBeenCalledOnce()
      drafts.appendToNativeChatComposerDraft(scope, { text: '' })
      expect(observer).not.toHaveBeenCalled()
      expect(drafts.readNativeChatComposerDraft(scope).text).toBe('')
      expect(pending.nativeChatPendingAttachmentSnapshot(scope)).toEqual([])
      expect(pending.settleNativeChatPendingAttachment(scope, `batch-chip-${i}`, '/late')).toBe(
        false
      )
      unsubscribe()
      unsubscribePending()
    }
    expect([...memory.records.keys()].filter((key) => !controls.includes(key))).toEqual([])
    const successor = snapshots[0]
    drafts.updateNativeChatComposerDraft(successor.scope, { text: 'fresh lifetime' }, 'immediate')
    snapshots.forEach(({ scope, attempt }) =>
      drafts.finishNativeChatComposerSubmission(scope, attempt, true)
    )
    expect(drafts.readNativeChatComposerDraft(successor.scope).text).toBe('fresh lifetime')
    controls.forEach((key, i) => {
      expect(drafts.readNativeChatComposerDraft(key).text).toBe('keep')
      expect(liveAttempts[i].draft?.text).toBe('keep')
      expect(pending.nativeChatPendingAttachmentSnapshot(key)).toHaveLength(1)
    })
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    drafts.clearNativeChatComposerDraftsForTests()
  }
)
