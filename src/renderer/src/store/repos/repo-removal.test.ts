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
