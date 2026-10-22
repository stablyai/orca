import { beforeEach, expect, it, vi } from 'vitest'
import { createEditorTabsStore } from '@/store/slices/editor-slice-test-harness'
import { openMarkdownPreviewToSide } from './markdown-preview-open'

let store: ReturnType<typeof createEditorTabsStore>
vi.mock('@/store', () => ({ useAppStore: { getState: () => store.getState() } }))

const file = {
  filePath: '/outside/notes.md',
  relativePath: '/outside/notes.md',
  worktreeId: 'wt-1',
  language: 'markdown',
  runtimeEnvironmentId: 'env-1',
  terminalArtifactGrantId: 'grant-1',
  readOnly: true
}

beforeEach(() => {
  store = createEditorTabsStore()
})

it('keeps the source visible, preserves the remote grant and reuses the side preview', () => {
  const source = store
    .getState()
    .createUnifiedTab('wt-1', 'terminal', { entityId: 'chat-1', label: 'Chat' })
  expect(openMarkdownPreviewToSide(file, { sourceGroupId: source.groupId })).toBe(true)
  const first = store.getState()
  const preview = first.openFiles.find((entry) => entry.mode === 'markdown-preview')
  expect(preview).toMatchObject(file)
  const previewTab = first.unifiedTabsByWorktree['wt-1'].find((tab) => tab.entityId === preview?.id)
  expect(previewTab?.groupId).not.toBe(source.groupId)
  expect(
    first.groupsByWorktree['wt-1'].find((group) => group.id === source.groupId)?.activeTabId
  ).toBe(source.id)
  expect(first.groupsByWorktree['wt-1']).toHaveLength(2)

  expect(openMarkdownPreviewToSide(file, { sourceGroupId: source.groupId })).toBe(true)
  expect(store.getState().groupsByWorktree['wt-1']).toHaveLength(2)
  expect(store.getState().openFiles).toHaveLength(1)
  expect(store.getState().unifiedTabsByWorktree['wt-1']).toHaveLength(2)
})

it('does not split a closed source group or a non-Markdown document', () => {
  const source = store
    .getState()
    .createUnifiedTab('wt-1', 'terminal', { entityId: 'chat-1', label: 'Chat' })
  expect(openMarkdownPreviewToSide(file, { sourceGroupId: 'closed-group' })).toBe(false)
  expect(
    openMarkdownPreviewToSide(
      { ...file, filePath: '/outside/notes.json' },
      { sourceGroupId: source.groupId }
    )
  ).toBe(false)
  expect(store.getState().groupsByWorktree['wt-1']).toHaveLength(1)
  expect(store.getState().openFiles).toHaveLength(0)
})

it('opens the first preview when a resolved destination workspace has no groups yet', () => {
  expect(openMarkdownPreviewToSide(file)).toBe(true)
  expect(store.getState().openFiles).toEqual([
    expect.objectContaining({ ...file, mode: 'markdown-preview' })
  ])
  expect(store.getState().groupsByWorktree['wt-1']).toHaveLength(1)
  expect(store.getState().unifiedTabsByWorktree['wt-1']).toHaveLength(1)
})
