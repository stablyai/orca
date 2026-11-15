import { afterEach, expect, it, vi } from 'vitest'
import { createTestStore } from '@/store/testing/app-store-test-fixture'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import type { AppState } from '@/store/types'

const holder = vi.hoisted((): { getState: (() => AppState) | null } => ({ getState: null }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => holder.getState!() } }))

import { saveProjectTextDraft } from './save-project-text-draft'

afterEach(() => vi.unstubAllGlobals())

it('keeps text typed while the Save dialog was open in the project draft', async () => {
  const store = createTestStore()
  holder.getState = store.getState
  store.setState({
    repos: [TEST_REPO],
    activeRepoId: TEST_REPO.id,
    activeWorktreeId: 'main',
    worktreesByRepo: {
      [TEST_REPO.id]: [makeWorktree({ id: 'main', repoId: TEST_REPO.id, path: '/repo1' })]
    }
  })
  store.getState().openNewProjectTextDraft()
  const file = store.getState().openFiles.find((file) => file.projectDraftProjectId)!
  store.getState().setEditorDraft(file.id, 'snapshot for disk')
  store.getState().markFileDirty(file.id, true)
  const saveDialog = Promise.withResolvers<{ canceled: false; destinationPath: string }>()
  vi.stubGlobal('window', {
    api: { fs: { saveDownloadedFile: () => saveDialog.promise } }
  })

  const save = saveProjectTextDraft(file, 'snapshot for disk')
  store.getState().setEditorDraft(file.id, 'newer text typed while saving')
  saveDialog.resolve({ canceled: false, destinationPath: '/repo1/saved.txt' })

  expect(await save).toBe(false)
  expect(store.getState().editorDrafts[file.id]).toBe('newer text typed while saving')
  expect(store.getState().openFiles.find((candidate) => candidate.id === file.id)).toMatchObject({
    projectDraftProjectId: 'repo1',
    isDirty: true
  })
})
