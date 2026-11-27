// @vitest-environment happy-dom
// Guards issue #49061: saving a Markdown document already in the list, and the watch event its write
// raises, start no worktree listing (each one spawns ripgrep on main).
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MarkdownDocument } from '../../../../../../shared/file-listing/file-document'
import type { FsChangeEvent } from '../../../../../../shared/file-watch/filesystem-change-event'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { ORCA_WORKTREE_FILE_CHANGE_EVENT } from '@/runtime/files/watching/worktree-file-change-event'
import { getLatestMarkdownMembershipChangeAt } from './use-markdown-document-watch-refresh'
import { useMarkdownDocuments } from './useMarkdownDocuments'

const ROOT = '/repo'
const listed: MarkdownDocument[] = [
  { filePath: '/repo/README.md', relativePath: 'README.md', basename: 'README.md', name: 'README' },
  { filePath: '/repo/docs/a.md', relativePath: 'docs/a.md', basename: 'a.md', name: 'a' }
]
let listings = 0

vi.mock('@/store/index', () => {
  const state: Record<string, never> = {}
  const useAppStore = Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
    getState: () => state
  })
  return { useAppStore }
})
vi.mock('./markdown-document-worktree-path-selector', () => ({
  selectMarkdownDocumentWorktreePath: () => ROOT
}))
vi.mock('@/lib/workspace/ownership/connection-owner-resolution', () => ({
  getConnectionIdFromState: () => null
}))
vi.mock('@/lib/files/access/file-owner-runtime-target', () => ({
  getRuntimeTargetForFileOwner: () => ({ kind: 'local' })
}))
vi.mock('../../file-ownership/restored-editor-workspace-runtime-owner', () => ({
  findRestoredEditorWorkspaceRuntimeOwner: () => null
}))
vi.mock('@/runtime/files/metadata/runtime-file-metadata-client', () => ({
  listRuntimeMarkdownDocuments: async () => {
    listings += 1
    return listed
  },
  statRuntimePath: async () => ({ size: 0, isDirectory: false, mtime: 0 })
}))

function openMarkdown(filePath: string): OpenFile {
  return {
    id: filePath,
    filePath,
    relativePath: filePath.slice(ROOT.length + 1),
    worktreeId: 'wt',
    language: 'markdown',
    isDirty: false,
    mode: 'edit'
  }
}

async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000)
  })
}

async function mount(filePath: string) {
  const hook = renderHook(() =>
    useMarkdownDocuments(openMarkdown(filePath), true, 'source', async () => true)
  )
  await settle()
  expect(listings).toBe(1)
  return hook
}

function dispatchWatchEvent(...events: FsChangeEvent[]): void {
  act(() => {
    window.dispatchEvent(
      new CustomEvent(ORCA_WORKTREE_FILE_CHANGE_EVENT, {
        detail: { runtimeEnvironmentId: null, payload: { worktreePath: ROOT, events } }
      })
    )
  })
}

async function watchEvent(...events: FsChangeEvent[]): Promise<void> {
  dispatchWatchEvent(...events)
  await settle()
}

beforeEach(() => {
  vi.useFakeTimers()
  listings = 0
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('lists nothing when a listed document is saved and its write arrives as a create', async () => {
  const { result } = await mount('/repo/docs/a.md')

  await act(async () => {
    await result.current.mdSave('# a')
  })
  await watchEvent(
    { kind: 'delete', absolutePath: '/repo/docs/.a.md.orca-save-1' },
    { kind: 'create', absolutePath: '/repo/docs/a.md' }
  )

  expect(listings).toBe(1)
})

it('records a listed path recreated before the armed listing starts', async () => {
  await mount('/repo/docs/a.md')

  dispatchWatchEvent({ kind: 'delete', absolutePath: '/repo/docs/a.md' })
  const deletedAt = getLatestMarkdownMembershipChangeAt(null, ROOT)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50)
  })
  // A listing joined after the delete could predate the recreate unless freshAfter moves past it.
  dispatchWatchEvent({ kind: 'create', absolutePath: '/repo/docs/a.md' })

  expect(getLatestMarkdownMembershipChangeAt(null, ROOT)).toBeGreaterThan(deletedAt ?? Infinity)
  await settle()
  expect(listings).toBe(2)
})
