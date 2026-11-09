// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { FileContent } from './editor-panel-content-types'

const mocks = vi.hoisted(() => ({
  readRuntimeFileContent: vi.fn(),
  findWorkspaceFileRoute: vi.fn(),
  getState: vi.fn()
}))

vi.mock('@/runtime/files/runtime-file-routing', () => ({
  getRuntimeFileReadScope: vi.fn(
    (
      settings: { activeRuntimeEnvironmentId?: string | null } | null | undefined,
      connectionId?: string
    ) => connectionId ?? settings?.activeRuntimeEnvironmentId ?? null
  )
}))
vi.mock('@/runtime/files/reads/runtime-file-read-client', () => ({
  readRuntimeFileContent: mocks.readRuntimeFileContent
}))
vi.mock('@/runtime/files/watching/runtime-file-watch-client', () => ({
  subscribeRuntimeFileChanges: vi.fn()
}))

vi.mock('@/runtime/source-control/git/runtime-git-diff-client', () => ({
  getRuntimeGitBranchDiff: vi.fn(),
  getRuntimeGitCommitDiff: vi.fn(),
  getRuntimeGitDiff: vi.fn()
}))
vi.mock('@/runtime/source-control/git/runtime-git-client-context', () => ({
  getRuntimeGitScope: vi.fn(() => null)
}))

vi.mock('@/lib/workspace/ownership/connection-context', () => ({
  getConnectionId: vi.fn(() => null),
  getConnectionIdForFile: vi.fn(() => null),
  isWorktreeConnectionResolved: vi.fn(() => true)
}))

vi.mock(
  '@/lib/workspace/ownership/worktree-host-connection-phase',
  () => import('./local-host-test-fixture')
)

vi.mock('@/lib/runtime-workspace-file-route', () => ({
  findWorkspaceFileRoute: mocks.findWorkspaceFileRoute
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (select: (state: ReturnType<typeof mocks.getState>) => unknown) => select(mocks.getState()),
    { getState: mocks.getState }
  )
}))

vi.mock('./external-changes/useEditorPanelExternalContentEvents', () => ({
  useEditorPanelExternalContentEvents: vi.fn(),
  usePruneClosedEditorContent: vi.fn()
}))

vi.mock('./useEditorPanelFileLoadRetry', () => ({ useEditorPanelFileLoadRetry: vi.fn() }))
vi.mock('./useLocalLogTail', () => ({ useLocalLogTail: vi.fn() }))

import { useEditorPanelContentState } from './useEditorPanelContentState'

let latestFileContents: Record<string, FileContent> = {}

function createFloatingFile(filePath: string, overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id: filePath,
    filePath,
    // Why: floating tabs store a path relative to the floating root (~ by default).
    relativePath: filePath.slice('/Users/me/'.length),
    worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
    language: 'markdown',
    isDirty: false,
    mode: 'edit',
    ...overrides
  }
}

function HookProbe({ activeFile }: { activeFile: OpenFile }): null {
  latestFileContents = useEditorPanelContentState({
    activeFile,
    isChangesMode: false,
    openFiles: [activeFile],
    gitStatusEntries: undefined,
    editorViewMode: {}
  }).fileContents
  return null
}

describe('restored client-local editor tabs', () => {
  let container: HTMLDivElement | null = null
  let root: Root | null = null

  beforeEach(() => {
    latestFileContents = {}
    // Restored reads must work without re-granting or preparing file access.
    vi.stubGlobal('api', { fs: {} })
    mocks.readRuntimeFileContent.mockReset()
    mocks.readRuntimeFileContent.mockResolvedValue({ content: '# local', isBinary: false })
    mocks.findWorkspaceFileRoute.mockReset()
    mocks.findWorkspaceFileRoute.mockReturnValue(null)
    mocks.getState.mockReset()
    mocks.getState.mockReturnValue({
      settings: null,
      openFiles: [],
      setLastKnownDiskSignature: vi.fn()
    })
    container = document.body.appendChild(document.createElement('div'))
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
  })

  // The notebook kernel and environment handlers check the same file path as user-named.
  it.each(['/Users/me/notes.txt', '/Users/me/analysis.ipynb'])(
    'reads %s as the file the user named after a restart',
    async (filePath) => {
      const activeFile = createFloatingFile(filePath)

      await act(async () => root?.render(<HookProbe activeFile={activeFile} />))

      await vi.waitFor(() => expect(latestFileContents[activeFile.id]?.content).toBe('# local'))
      expect(mocks.readRuntimeFileContent).toHaveBeenCalledTimes(1)
      expect(mocks.readRuntimeFileContent).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath,
          connectionId: undefined,
          access: { kind: 'user-file' }
        })
      )
    }
  )

  it('keeps an absolute floating file in its panel when a project also owns the path', async () => {
    const filePath = '/project/readme.md'
    const activeFile = createFloatingFile(filePath, { relativePath: filePath })
    mocks.findWorkspaceFileRoute.mockReturnValue({
      worktreeId: 'folder:project',
      relativePath: 'readme.md',
      executionHostId: 'local'
    })

    await act(async () => root?.render(<HookProbe activeFile={activeFile} />))

    await vi.waitFor(() => expect(latestFileContents[activeFile.id]?.content).toBe('# local'))
    expect(mocks.findWorkspaceFileRoute).not.toHaveBeenCalled()
    expect(mocks.readRuntimeFileContent).toHaveBeenCalledWith(
      expect.objectContaining({ filePath, access: { kind: 'user-file' } })
    )
  })
})
