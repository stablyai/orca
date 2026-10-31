import { describe, expect, it } from 'vitest'
import { countOpenRepoTerminalTabs } from './repo-removal'

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
  const remove = vi.fn().mockRejectedValueOnce(new Error('refused')).mockResolvedValue(undefined)
  vi.stubGlobal('window', { api: { repos: { removeForHost: remove }, pty: { kill: vi.fn() } } })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const store = createTestStore()
  store.setState({
    repos: [{ ...TEST_REPO, id: 'repo-1' }],
    worktreesByRepo: {
      'repo-1': [makeWorktree({ id: 'wt-1', repoId: 'repo-1', hostId: 'local' })]
    }
  })
  const key = drafts.nativeChatLaunchPromptDraftScopeKey('wt-1', 'codex', 'local')
  drafts.updateNativeChatComposerDraft(key, { text: 'project task' }, 'immediate')
  const submission = drafts.captureNativeChatComposerSubmission(key)
  await store.getState().removeProject('repo-1', { hostId: 'local' })
  expect(submission.draft?.text).toBe('project task')
  await store.getState().removeProject('repo-1', { hostId: 'local' })
  expect(remove).toHaveBeenCalledTimes(2)
  expect(submission.draft).toBeUndefined()
  expect(drafts.readNativeChatComposerDraft(key).text).toBe('')
  drafts.finishNativeChatComposerSubmission(key, submission, true)
  expect(drafts.readNativeChatComposerDraft(key).text).toBe('')
  drafts.clearNativeChatComposerDraftsForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
