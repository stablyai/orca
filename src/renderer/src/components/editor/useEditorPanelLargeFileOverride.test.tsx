// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type { GitStatusEntry } from '../../../../shared/git-status-types'
import {
  EDITOR_TEXT_READ_LIMIT_BYTES,
  formatFileTooLargeMessage
} from '../../../../shared/editor-file-read-limit'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  readRuntimeFileContent: vi.fn()
}))

vi.mock('@/runtime/runtime-file-client', () => ({
  getRuntimeFileReadScope: vi.fn(() => null),
  readRuntimeFileContent: mocks.readRuntimeFileContent,
  subscribeRuntimeFileChanges: vi.fn()
}))

vi.mock('@/runtime/runtime-git-client', () => ({
  getRuntimeGitBranchDiff: vi.fn(),
  getRuntimeGitCommitDiff: vi.fn(),
  getRuntimeGitDiff: vi.fn(),
  getRuntimeGitScope: vi.fn(() => null)
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: vi.fn(),
  getConnectionIdForFile: vi.fn(),
  isWorktreeConnectionResolved: vi.fn(() => true)
}))

vi.mock('@/lib/runtime-workspace-file-route', () => ({
  findWorkspaceFileRoute: vi.fn(() => null)
}))

vi.mock('@/store', () => ({ useAppStore: { getState: mocks.getState } }))

import { ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT } from './editor-autosave'
import type { EditorContentReloadOptions, FileContent } from './editor-panel-content-types'
import { useEditorPanelContentState } from './useEditorPanelContentState'

const REFUSAL = formatFileTooLargeMessage({
  byteLength: 60 * 1024 * 1024,
  limitBytes: EDITOR_TEXT_READ_LIMIT_BYTES.local,
  scope: 'local'
})

const BIG_FILE: OpenFile = {
  id: '/repo/build.log',
  filePath: '/repo/build.log',
  relativePath: 'build.log',
  worktreeId: 'wt-1',
  language: 'plaintext',
  isDirty: false,
  mode: 'edit'
}

const OTHER_FILE: OpenFile = { ...BIG_FILE, id: '/repo/other.ts', filePath: '/repo/other.ts' }

// A conflict-review overview renders its rows from synthetic content files whose
// ids are absolute paths; those ids never enter `openFiles`.
const CONFLICT_PATH = '/repo/huge.sql'
const REVIEW_FILE: OpenFile = {
  id: 'conflict-review:/repo',
  filePath: '/repo',
  relativePath: '',
  worktreeId: 'wt-1',
  language: 'plaintext',
  isDirty: false,
  mode: 'conflict-review',
  conflictReview: {
    source: 'live-summary',
    snapshotTimestamp: 1,
    entries: [{ path: 'huge.sql', conflictKind: 'both_modified' }]
  }
}
const REVIEW_CONTENT_FILE: OpenFile = {
  id: CONFLICT_PATH,
  filePath: CONFLICT_PATH,
  relativePath: 'huge.sql',
  worktreeId: 'wt-1',
  language: 'sql',
  isDirty: false,
  mode: 'edit',
  conflict: {
    kind: 'conflict-editable',
    conflictKind: 'both_modified',
    conflictStatus: 'unresolved',
    conflictStatusSource: 'git'
  }
}
function conflictEntries(): GitStatusEntry[] {
  return [
    {
      path: 'huge.sql',
      status: 'modified',
      area: 'unstaged',
      conflictKind: 'both_modified',
      conflictStatus: 'unresolved',
      conflictStatusSource: 'git'
    }
  ]
}

let latestFileContents: Record<string, FileContent> = {}
let latestReloadContent: (file: OpenFile, options?: EditorContentReloadOptions) => void = () => {}

function HookProbe({
  activeFile,
  openFiles,
  gitStatusEntries
}: {
  activeFile: OpenFile | null
  openFiles: OpenFile[]
  gitStatusEntries?: GitStatusEntry[]
}): null {
  const state = useEditorPanelContentState({
    activeFile,
    isChangesMode: false,
    openFiles,
    gitStatusEntries,
    editorViewMode: {}
  })
  latestFileContents = state.fileContents
  latestReloadContent = state.reloadContent
  return null
}

describe('editor large-file override', () => {
  let container: HTMLDivElement | null = null
  let root: Root | null = null

  beforeEach(() => {
    latestFileContents = {}
    ;(window as unknown as { api: unknown }).api = {
      fs: { authorizeExternalPath: vi.fn().mockResolvedValue(undefined) }
    }
    mocks.getState.mockReset()
    mocks.getState.mockReturnValue({
      settings: null,
      openFiles: [],
      setLastKnownDiskSignature: vi.fn()
    })
    mocks.readRuntimeFileContent.mockReset()
    mocks.readRuntimeFileContent.mockImplementation(
      async ({ filePath, allowLargeFile }: { filePath: string; allowLargeFile?: boolean }) => {
        if (filePath !== BIG_FILE.filePath && filePath !== CONFLICT_PATH) {
          return { content: 'other content', isBinary: false }
        }
        if (allowLargeFile !== true) {
          throw new Error(REFUSAL)
        }
        return { content: 'huge content', isBinary: false }
      }
    )
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
    }
    container?.remove()
    container = null
    root = null
  })

  async function renderProbe(
    activeFile: OpenFile | null,
    openFiles: OpenFile[],
    gitStatusEntries?: GitStatusEntry[]
  ): Promise<void> {
    if (!root) {
      container = document.createElement('div')
      document.body.appendChild(container)
      root = createRoot(container)
    }
    await act(async () => {
      root?.render(
        <HookProbe
          activeFile={activeFile}
          openFiles={openFiles}
          gitStatusEntries={gitStatusEntries}
        />
      )
    })
  }

  async function openAnyway(): Promise<void> {
    await vi.waitFor(() => expect(latestFileContents[BIG_FILE.id]?.loadError).toBe(REFUSAL))
    await act(async () => {
      latestReloadContent(BIG_FILE, { allowLargeFile: true })
    })
    await vi.waitFor(() => expect(latestFileContents[BIG_FILE.id]?.content).toBe('huge content'))
  }

  // "Open Anyway" is this tab's budget from then on, not one read. A build log
  // keeps growing, so the watcher forces a reload seconds later; re-imposing the
  // budget there would swap the loaded file back to the too-large fallback.
  it('carries the override into an external-change reload', async () => {
    await renderProbe(BIG_FILE, [BIG_FILE])
    await openAnyway()

    act(() => {
      window.dispatchEvent(
        new CustomEvent(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, {
          detail: {
            worktreeId: BIG_FILE.worktreeId,
            worktreePath: '/repo',
            relativePath: BIG_FILE.relativePath
          }
        })
      )
    })

    await vi.waitFor(() => expect(mocks.readRuntimeFileContent).toHaveBeenCalledTimes(3))
    expect(mocks.readRuntimeFileContent.mock.calls[2][0]).toMatchObject({ allowLargeFile: true })
    expect(latestFileContents[BIG_FILE.id]?.content).toBe('huge content')
    expect(latestFileContents[BIG_FILE.id]?.loadError).toBeUndefined()
  })

  // The background path: an invalidated tab reloads on reveal with no options at
  // all, so the override has to live with the tab rather than with the click.
  it('carries the override into a reload on reveal', async () => {
    const openFiles = [BIG_FILE, OTHER_FILE]
    await renderProbe(BIG_FILE, openFiles)
    await openAnyway()

    await renderProbe(OTHER_FILE, openFiles)
    act(() => {
      window.dispatchEvent(
        new CustomEvent(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, {
          detail: {
            worktreeId: BIG_FILE.worktreeId,
            worktreePath: '/repo',
            relativePath: BIG_FILE.relativePath
          }
        })
      )
    })
    await vi.waitFor(() => expect(latestFileContents[BIG_FILE.id]?.isStale).toBe(true))

    await renderProbe(BIG_FILE, openFiles)

    await vi.waitFor(() => expect(latestFileContents[BIG_FILE.id]?.isStale).toBeUndefined())
    expect(latestFileContents[BIG_FILE.id]?.content).toBe('huge content')
    expect(latestFileContents[BIG_FILE.id]?.loadError).toBeUndefined()
  })

  // Closing a tab is not evidence that nothing is showing the file: conflict-review
  // rows render the same content ids. So the override outlives the tab, and the
  // consent it records lasts as long as this panel does.
  it('keeps the override when the tab is closed and reopened', async () => {
    await renderProbe(BIG_FILE, [BIG_FILE])
    await openAnyway()

    await renderProbe(null, [])
    await renderProbe(BIG_FILE, [BIG_FILE])

    await vi.waitFor(() => expect(latestFileContents[BIG_FILE.id]?.content).toBe('huge content'))
    expect(latestFileContents[BIG_FILE.id]?.loadError).toBeUndefined()
  })

  // Selecting a review row opens a real tab under the same content id, so a
  // tab-close prune reverted the row behind it — the row reloaded into the
  // refusal the user had already overruled.
  it('keeps a review row open after the tab for that row closes', async () => {
    await renderProbe(REVIEW_CONTENT_FILE, [REVIEW_FILE, REVIEW_CONTENT_FILE], conflictEntries())
    await vi.waitFor(() => expect(latestFileContents[CONFLICT_PATH]?.loadError).toBe(REFUSAL))
    await act(async () => {
      latestReloadContent(REVIEW_CONTENT_FILE, { allowLargeFile: true })
    })
    await vi.waitFor(() => expect(latestFileContents[CONFLICT_PATH]?.content).toBe('huge content'))

    // Closing the file tab leaves the overview row rendering the same content id,
    // and the row reloads with no options on the next poll or retry.
    await renderProbe(REVIEW_FILE, [REVIEW_FILE], conflictEntries())
    await act(async () => {
      latestReloadContent(REVIEW_CONTENT_FILE)
    })

    await vi.waitFor(() => expect(latestFileContents[CONFLICT_PATH]?.content).toBe('huge content'))
    expect(latestFileContents[CONFLICT_PATH]?.loadError).toBeUndefined()
  })

  // A conflict-review row's content id is an absolute path that never belongs to
  // `openFiles`, so pruning it as a "closed tab" made Open Anyway a one-shot that
  // the next unrelated tab change reverted.
  it('keeps the override for a conflict-review row when an unrelated tab opens', async () => {
    await renderProbe(REVIEW_FILE, [REVIEW_FILE], conflictEntries())
    await vi.waitFor(() => expect(latestFileContents[CONFLICT_PATH]?.loadError).toBe(REFUSAL))
    await act(async () => {
      latestReloadContent(REVIEW_CONTENT_FILE, { allowLargeFile: true })
    })
    await vi.waitFor(() => expect(latestFileContents[CONFLICT_PATH]?.content).toBe('huge content'))

    // Opening another tab reruns the prune; a later status poll reloads the row.
    await renderProbe(REVIEW_FILE, [REVIEW_FILE, OTHER_FILE], conflictEntries())
    await renderProbe(REVIEW_FILE, [REVIEW_FILE, OTHER_FILE], conflictEntries())

    await vi.waitFor(() => expect(latestFileContents[CONFLICT_PATH]?.content).toBe('huge content'))
    expect(latestFileContents[CONFLICT_PATH]?.loadError).toBeUndefined()
  })
})
