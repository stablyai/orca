import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { makeWorktree } from '../worktree.test-fixture'
import { applyRemoveWorktreeSuccessState } from './remove-worktree-store-cleanup'

const show = vi.hoisted(() => vi.fn())
vi.mock('@/components/editor/model-lifetime/retention/closed-unsaved-files-toast', () => ({
  showClosedUnsavedFilesToast: show
}))

function tab(id: string, worktreeId: string, patch: Partial<OpenFile> = {}): OpenFile {
  return {
    id,
    filePath: '/repo/a.ts',
    relativePath: 'a.ts',
    worktreeId,
    language: 'typescript',
    isDirty: false,
    mode: 'edit',
    lastKnownDiskSignature: 'sig-base',
    ...patch
  }
}

const state = () => useAppStore.getState()

beforeEach(() => {
  show.mockClear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.stubGlobal('window', { api: { pty: { kill: vi.fn() } } })
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    worktreesByRepo: {
      'repo-1': [
        makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'local' }),
        makeWorktree({ id: 'wt-2', repoId: 'repo-1', path: '/repo', hostId: 'local' })
      ]
    }
  })
})
afterEach(() => vi.unstubAllGlobals())

it('removing one workspace keeps the shared record, its draft and its key in the other', async () => {
  useAppStore.setState({
    openFiles: [tab('a', 'wt-1', { isDirty: true }), tab('b', 'wt-2', { isDirty: true })],
    editorDrafts: { a: 'shared edits', b: 'shared edits' }
  })

  applyRemoveWorktreeSuccessState(useAppStore.setState, 'wt-2', new Set(), 'local')
  await Promise.resolve()

  expect(state().openFiles.map((file) => file.id)).toEqual(['a'])
  // Same record id: the autosave timer and queued save keyed by it carry on.
  expect(state().editorDrafts.a).toBe('shared edits')
  expect(state().openFiles[0]?.isDirty).toBe(true)
})

it("a removal with no prompt keeps the last view's dirty record; reopening the file joins it", async () => {
  useAppStore.setState({
    openFiles: [tab('b', 'wt-2', { isDirty: true })],
    editorDrafts: { b: 'only copy' }
  })

  applyRemoveWorktreeSuccessState(useAppStore.setState, 'wt-2', new Set(), 'local')
  await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1))
  expect(state().openFiles).toEqual([])

  useAppStore.setState({ openFiles: [tab('a', 'wt-1')] })
  expect(state().editorDrafts.a).toBe('only copy')
  expect(state().openFiles[0]?.isDirty).toBe(true)
})

import * as drafts from '@/components/native-chat/drafts/native-chat-draft-reset'
import * as draftsOwner1 from '@/components/native-chat/drafts/native-chat-launch-draft-source'
import * as draftsOwner2 from '@/components/native-chat/drafts/native-chat-composer-draft-store'
import * as draftsOwner3 from '@/components/native-chat/drafts/native-chat-composer-draft-memory'
import { captureWorktreeStateBeforeRemoval } from './worktree-state-before-removal'
import { tearDownRemovedWorktreeRendererState } from './removed-worktree-renderer-teardown'

it('committed worktree teardown retires empty pending launch source authority without touching another owner', async () => {
  drafts.clearNativeChatComposerDraftsForTests()
  const key = draftsOwner1.nativeChatLaunchPromptDraftScopeKey('wt-1', 'claude')
  const other = draftsOwner1.nativeChatLaunchPromptDraftScopeKey('wt-1', 'claude', 'ssh:other')
  for (const scope of [key, other]) {
    draftsOwner2.updateNativeChatComposerDraft(scope, { text: 'task' }, 'immediate')
  }
  const submission = draftsOwner3.captureNativeChatComposerSubmission(key)
  draftsOwner2.updateNativeChatComposerDraft(key, { text: '' }, 'immediate')
  const beforeRemoval = captureWorktreeStateBeforeRemoval(state(), 'wt-1', 'local')
  useAppStore.setState({
    shutdownWorktreeBrowsers: vi.fn(),
    shutdownWorktreeTerminals: vi.fn(),
    deleteManagedBrowserSessionProfile: vi.fn()
  })
  await tearDownRemovedWorktreeRendererState({
    set: useAppStore.setState,
    get: state,
    worktreeId: 'wt-1',
    hostId: 'local',
    requiredExecutionHostId: 'local',
    beforeRemoval
  })
  draftsOwner2.updateNativeChatComposerDraft(key, { text: 'recreated' }, 'immediate')
  draftsOwner2.finishNativeChatComposerSubmission(key, submission, true)
  expect(draftsOwner2.readNativeChatComposerDraft(key).text).toBe('recreated')
  expect(draftsOwner2.readNativeChatComposerDraft(other).text).toBe('task')
  drafts.clearNativeChatComposerDraftsForTests()
})
