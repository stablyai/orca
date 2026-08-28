// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type { FileContent } from './editor-panel-content-types'

const mocks = vi.hoisted(() => ({
  readRuntimeFileContent: vi.fn(),
  findWorkspaceFileRoute: vi.fn(),
  migrateRestoredEditorFileOwner: vi.fn(),
  getState: vi.fn()
}))

vi.mock('@/runtime/runtime-file-client', () => ({
  getRuntimeFileReadScope: vi.fn(
    (
      settings: { activeRuntimeEnvironmentId?: string | null } | null | undefined,
      connectionId?: string
    ) => connectionId ?? settings?.activeRuntimeEnvironmentId ?? null
  ),
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
  findWorkspaceFileRoute: mocks.findWorkspaceFileRoute
}))

vi.mock('./migrate-restored-editor-file-owner', () => ({
  migrateRestoredEditorFileOwner: mocks.migrateRestoredEditorFileOwner
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: vi.fn(() => 'local')
}))

vi.mock('@/store', () => ({ useAppStore: { getState: mocks.getState } }))

vi.mock('./useEditorPanelExternalContentEvents', () => ({
  useEditorPanelExternalContentEvents: vi.fn(),
  usePruneClosedEditorContent: vi.fn()
}))

vi.mock('./useEditorPanelFileLoadRetry', () => ({ useEditorPanelFileLoadRetry: vi.fn() }))
vi.mock('./useLocalLogTail', () => ({ useLocalLogTail: vi.fn() }))

import { useEditorPanelContentState } from './useEditorPanelContentState'

const authorizeExternalPath = vi.fn()
let latestFileContents: Record<string, FileContent> = {}

function createOpenFile(overrides: Partial<OpenFile>): OpenFile {
  return {
    id: '/repo/file.ts',
    filePath: '/repo/file.ts',
    relativePath: 'file.ts',
    worktreeId: 'wt-1',
    language: 'typescript',
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

describe('remote sibling editor content routing', () => {
  let container: HTMLDivElement | null = null
  let root: Root | null = null

  beforeEach(() => {
    latestFileContents = {}
    authorizeExternalPath.mockReset()
    authorizeExternalPath.mockResolvedValue(undefined)
    ;(window as unknown as { api: unknown }).api = { fs: { authorizeExternalPath } }
    mocks.readRuntimeFileContent.mockReset()
    mocks.findWorkspaceFileRoute.mockReset()
    mocks.findWorkspaceFileRoute.mockReturnValue(null)
    mocks.migrateRestoredEditorFileOwner.mockReset()
    mocks.migrateRestoredEditorFileOwner.mockResolvedValue({ ok: true, fileId: 'owned-file' })
    mocks.getState.mockReset()
    mocks.getState.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: 'runtime-1' },
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

  it('keeps a client-local live-tail log on the client', async () => {
    const logPath = '/Users/me/.codex/sessions/session.jsonl'
    const activeFile = createOpenFile({
      id: logPath,
      filePath: logPath,
      relativePath: logPath,
      worktreeId: 'repo-runtime::/work/demo-project',
      readOnly: true,
      liveTail: true
    })
    mocks.readRuntimeFileContent.mockResolvedValue({ content: 'log line', isBinary: false })

    await act(async () => root?.render(<HookProbe activeFile={activeFile} />))

    await vi.waitFor(() => expect(latestFileContents[activeFile.id]?.content).toBe('log line'))
    expect(mocks.findWorkspaceFileRoute).not.toHaveBeenCalled()
    expect(authorizeExternalPath).toHaveBeenCalledWith({ targetPath: logPath })
    expect(mocks.readRuntimeFileContent).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: undefined, includeLocalLogMetadata: true })
    )
  })

  it('atomically reparents an unstamped sibling file before reading', async () => {
    const activeFile = createOpenFile({
      id: '/work/repo-b/docs/readme.md',
      filePath: '/work/repo-b/docs/readme.md',
      relativePath: '/work/repo-b/docs/readme.md',
      worktreeId: 'repo-a::/work/repo-a'
    })
    const route = {
      worktreeId: 'repo-b::/work/repo-b',
      relativePath: 'docs/readme.md',
      executionHostId: 'runtime:runtime-1'
    } as const
    mocks.findWorkspaceFileRoute.mockReturnValue(route)

    await act(async () => root?.render(<HookProbe activeFile={activeFile} />))

    await vi.waitFor(() =>
      expect(mocks.migrateRestoredEditorFileOwner).toHaveBeenCalledWith(
        activeFile.id,
        route,
        'runtime-1'
      )
    )
    expect(authorizeExternalPath).not.toHaveBeenCalled()
    expect(mocks.readRuntimeFileContent).not.toHaveBeenCalled()
  })

  it('reports a sibling-owner collision instead of remaining in loading state', async () => {
    const activeFile = createOpenFile({
      id: '/work/repo-b/docs/readme.md',
      filePath: '/work/repo-b/docs/readme.md',
      relativePath: '/work/repo-b/docs/readme.md',
      worktreeId: 'repo-a::/work/repo-a'
    })
    mocks.findWorkspaceFileRoute.mockReturnValue({
      worktreeId: 'repo-b::/work/repo-b',
      relativePath: 'docs/readme.md',
      executionHostId: 'runtime:runtime-1'
    })
    mocks.migrateRestoredEditorFileOwner.mockResolvedValue({
      ok: false,
      reason: 'collision'
    })

    await act(async () => root?.render(<HookProbe activeFile={activeFile} />))

    await vi.waitFor(() =>
      expect(latestFileContents[activeFile.id]?.loadError).toBe(
        'The sibling file is already open; close one tab before restoring it.'
      )
    )
  })
})
