// @vitest-environment happy-dom

import { act, useLayoutEffect, useMemo } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type { GitStatusEntry } from '../../../../shared/git-status-types'
import type { DiffContent, FileContent } from './editor-panel-content-types'

const mocks = vi.hoisted(() => ({
  getRuntimeGitDiff: vi.fn(),
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
  getRuntimeGitDiff: mocks.getRuntimeGitDiff,
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
import { useEditorPanelContentState } from './useEditorPanelContentState'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

type ProbeSnapshot = {
  diffContents: Record<string, DiffContent>
  fileContents: Record<string, FileContent>
}

type ProbeProps = {
  activeFile: OpenFile
  editorViewMode?: Record<string, 'edit' | 'changes'>
  gitStatusEntries?: GitStatusEntry[]
  isChangesMode?: boolean
  isVisible?: boolean
  name?: string
  openFiles?: OpenFile[]
}

const snapshots = new Map<string, ProbeSnapshot>()
const EMPTY_EDITOR_VIEW_MODE: Record<string, 'edit' | 'changes'> = {}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function makeFile(id: string, overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id,
    filePath: `/repo/${id}.ts`,
    relativePath: `${id}.ts`,
    worktreeId: 'wt-1',
    language: 'typescript',
    isDirty: false,
    mode: 'edit',
    ...overrides
  }
}

function Probe({
  activeFile,
  editorViewMode = EMPTY_EDITOR_VIEW_MODE,
  gitStatusEntries,
  isChangesMode = false,
  isVisible = true,
  name = 'main',
  openFiles
}: ProbeProps): null {
  const panelOpenFiles = useMemo(() => openFiles ?? [activeFile], [activeFile, openFiles])
  const state = useEditorPanelContentState({
    activeFile,
    editorViewMode,
    gitStatusEntries,
    isChangesMode,
    isVisible,
    openFiles: panelOpenFiles
  })
  snapshots.set(name, {
    diffContents: state.diffContents,
    fileContents: state.fileContents
  })
  return null
}

function dispatchExternalChange(file: OpenFile): void {
  act(() => {
    window.dispatchEvent(
      new CustomEvent(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, {
        detail: {
          worktreeId: file.worktreeId,
          worktreePath: '/repo',
          relativePath: file.relativePath
        }
      })
    )
  })
}

function ExternalChangeLayoutEmitter({ file }: { file: OpenFile }): null {
  useLayoutEffect(() => {
    window.dispatchEvent(
      new CustomEvent(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, {
        detail: {
          worktreeId: file.worktreeId,
          worktreePath: '/repo',
          relativePath: file.relativePath
        }
      })
    )
  }, [file])
  return null
}

function textDiff(modifiedContent: string): DiffContent {
  return {
    kind: 'text',
    originalContent: 'old',
    modifiedContent,
    originalIsBinary: false,
    modifiedIsBinary: false
  }
}

describe('useEditorPanelContentState visibility', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    snapshots.clear()
    mocks.getRuntimeGitDiff.mockReset()
    mocks.readRuntimeFileContent.mockReset()
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
    act(() => root.unmount())
    container.remove()
  })

  it('defers the initial remote read until reveal', async () => {
    const file = makeFile('initial')
    mocks.readRuntimeFileContent.mockResolvedValue({ content: 'remote', isBinary: false })

    await act(async () => root.render(<Probe activeFile={file} isVisible={false} />))
    expect(mocks.readRuntimeFileContent).not.toHaveBeenCalled()

    await act(async () => root.render(<Probe activeFile={file} />))
    await vi.waitFor(() =>
      expect(snapshots.get('main')?.fileContents[file.id]?.content).toBe('remote')
    )
    expect(mocks.readRuntimeFileContent).toHaveBeenCalledOnce()
  })

  it('invalidates a hidden tab and rejects its older in-flight result', async () => {
    const file = makeFile('stale')
    const staleRead = createDeferred<FileContent>()
    const freshRead = createDeferred<FileContent>()
    mocks.readRuntimeFileContent
      .mockReturnValueOnce(staleRead.promise)
      .mockReturnValueOnce(freshRead.promise)

    await act(async () => root.render(<Probe activeFile={file} />))
    await vi.waitFor(() => expect(mocks.readRuntimeFileContent).toHaveBeenCalledOnce())
    await act(async () => root.render(<Probe activeFile={file} isVisible={false} />))
    dispatchExternalChange(file)
    expect(mocks.readRuntimeFileContent).toHaveBeenCalledOnce()

    await act(async () => {
      staleRead.resolve({ content: 'stale', isBinary: false })
      await staleRead.promise
    })
    expect(snapshots.get('main')?.fileContents[file.id]).toBeUndefined()

    await act(async () => root.render(<Probe activeFile={file} />))
    await vi.waitFor(() => expect(mocks.readRuntimeFileContent).toHaveBeenCalledTimes(2))
    await act(async () => {
      freshRead.resolve({ content: 'fresh', isBinary: false })
      await freshRead.promise
    })
    await vi.waitFor(() =>
      expect(snapshots.get('main')?.fileContents[file.id]?.content).toBe('fresh')
    )
  })

  it('keeps invalidated bytes on screen until the reveal read lands', async () => {
    const file = makeFile('no-flash')
    const freshRead = createDeferred<FileContent>()
    mocks.readRuntimeFileContent
      .mockResolvedValueOnce({ content: 'old', isBinary: false })
      .mockReturnValueOnce(freshRead.promise)

    await act(async () => root.render(<Probe activeFile={file} />))
    await vi.waitFor(() =>
      expect(snapshots.get('main')?.fileContents[file.id]?.content).toBe('old')
    )

    await act(async () => root.render(<Probe activeFile={file} isVisible={false} />))
    dispatchExternalChange(file)
    expect(snapshots.get('main')?.fileContents[file.id]?.content).toBe('old')

    await act(async () => root.render(<Probe activeFile={file} />))
    await vi.waitFor(() => expect(mocks.readRuntimeFileContent).toHaveBeenCalledTimes(2))
    // Why: an unresolved reveal read must not blank the pane to "Loading…".
    expect(snapshots.get('main')?.fileContents[file.id]?.content).toBe('old')

    await act(async () => {
      freshRead.resolve({ content: 'fresh', isBinary: false })
      await freshRead.promise
    })
    await vi.waitFor(() =>
      expect(snapshots.get('main')?.fileContents[file.id]).toEqual({
        content: 'fresh',
        isBinary: false
      })
    )
  })

  it('does not re-read while the reveal read is still in flight', async () => {
    const file = makeFile('flip-flop')
    const pendingRead = createDeferred<FileContent>()
    mocks.readRuntimeFileContent.mockReturnValue(pendingRead.promise)

    await act(async () => root.render(<Probe activeFile={file} isVisible={false} />))
    await act(async () => root.render(<Probe activeFile={file} />))
    expect(mocks.readRuntimeFileContent).toHaveBeenCalledOnce()

    await act(async () => root.render(<Probe activeFile={file} isVisible={false} />))
    await act(async () => root.render(<Probe activeFile={file} />))
    expect(mocks.readRuntimeFileContent).toHaveBeenCalledOnce()

    await act(async () => {
      pendingRead.resolve({ content: 'remote', isBinary: false })
      await pendingRead.promise
    })
    await vi.waitFor(() =>
      expect(snapshots.get('main')?.fileContents[file.id]?.content).toBe('remote')
    )
    expect(mocks.readRuntimeFileContent).toHaveBeenCalledOnce()
  })

  it('publishes hidden visibility before a watcher event in the same commit', async () => {
    const file = makeFile('commit-visibility')
    mocks.readRuntimeFileContent.mockResolvedValue({ content: 'old', isBinary: false })

    await act(async () => root.render(<Probe activeFile={file} />))
    await vi.waitFor(() => expect(mocks.readRuntimeFileContent).toHaveBeenCalledOnce())

    await act(async () =>
      root.render(
        <>
          <Probe activeFile={file} isVisible={false} />
          <ExternalChangeLayoutEmitter file={file} />
        </>
      )
    )

    expect(mocks.readRuntimeFileContent).toHaveBeenCalledOnce()
    expect(snapshots.get('main')?.fileContents[file.id]).toEqual({
      content: 'old',
      isBinary: false,
      isStale: true
    })
  })

  it('shares one post-change read between visible source and preview panels', async () => {
    const source = makeFile('source', {
      filePath: '/repo/readme.md',
      relativePath: 'readme.md',
      language: 'markdown'
    })
    const preview = makeFile('preview', {
      filePath: '/repo/readme.md',
      relativePath: 'readme.md',
      language: 'markdown',
      mode: 'markdown-preview',
      markdownPreviewSourceFileId: source.id
    })
    mocks.readRuntimeFileContent
      .mockResolvedValueOnce({ content: 'old', isBinary: false })
      .mockResolvedValueOnce({ content: 'fresh', isBinary: false })

    await act(async () => {
      root.render(
        <>
          <Probe activeFile={source} name="source" openFiles={[source, preview]} />
          <Probe activeFile={preview} name="preview" openFiles={[source, preview]} />
        </>
      )
    })
    await vi.waitFor(() => expect(mocks.readRuntimeFileContent).toHaveBeenCalledOnce())

    dispatchExternalChange(source)
    await vi.waitFor(() => expect(mocks.readRuntimeFileContent).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => {
      expect(snapshots.get('source')?.fileContents[source.id]?.content).toBe('fresh')
      expect(snapshots.get('preview')?.fileContents[preview.id]?.content).toBe('fresh')
    })
  })

  it('invalidates a hidden file nonce without reading until reveal', async () => {
    const file = makeFile('file-nonce')
    mocks.readRuntimeFileContent
      .mockResolvedValueOnce({ content: 'old', isBinary: false })
      .mockResolvedValueOnce({ content: 'fresh', isBinary: false })

    await act(async () => root.render(<Probe activeFile={file} />))
    await vi.waitFor(() =>
      expect(snapshots.get('main')?.fileContents[file.id]?.content).toBe('old')
    )

    const changed = { ...file, fileContentReloadNonce: 1 }
    await act(async () => root.render(<Probe activeFile={changed} isVisible={false} />))
    expect(snapshots.get('main')?.fileContents[file.id]?.isStale).toBe(true)
    expect(mocks.readRuntimeFileContent).toHaveBeenCalledOnce()

    await act(async () => root.render(<Probe activeFile={changed} />))
    await vi.waitFor(() =>
      expect(snapshots.get('main')?.fileContents[file.id]?.content).toBe('fresh')
    )
    expect(mocks.readRuntimeFileContent).toHaveBeenCalledTimes(2)
  })

  it('invalidates a hidden diff nonce without reading until reveal', async () => {
    const file = makeFile('diff-nonce', { mode: 'diff', diffSource: 'unstaged' })
    const staleDiff = createDeferred<DiffContent>()
    const freshDiff = createDeferred<DiffContent>()
    mocks.getRuntimeGitDiff
      .mockReturnValueOnce(staleDiff.promise)
      .mockReturnValueOnce(freshDiff.promise)

    await act(async () => root.render(<Probe activeFile={file} />))
    await vi.waitFor(() => expect(mocks.getRuntimeGitDiff).toHaveBeenCalledOnce())

    const changed = { ...file, diffContentReloadNonce: 1 }
    await act(async () => root.render(<Probe activeFile={changed} isVisible={false} />))
    expect(mocks.getRuntimeGitDiff).toHaveBeenCalledOnce()
    await act(async () => {
      staleDiff.resolve(textDiff('stale diff'))
      await staleDiff.promise
    })
    expect(snapshots.get('main')?.diffContents[file.id]).toBeUndefined()

    await act(async () => root.render(<Probe activeFile={changed} />))
    await vi.waitFor(() => expect(mocks.getRuntimeGitDiff).toHaveBeenCalledTimes(2))
    await act(async () => {
      freshDiff.resolve(textDiff('fresh diff'))
      await freshDiff.promise
    })
    await vi.waitFor(() =>
      expect(snapshots.get('main')?.diffContents[file.id]?.modifiedContent).toBe('fresh diff')
    )
    expect(mocks.getRuntimeGitDiff).toHaveBeenCalledTimes(2)
  })

  it('keeps an invalidated diff on screen until the reveal read lands', async () => {
    const file = makeFile('diff-no-flash', { mode: 'diff', diffSource: 'unstaged' })
    const freshDiff = createDeferred<DiffContent>()
    mocks.getRuntimeGitDiff
      .mockResolvedValueOnce(textDiff('old diff'))
      .mockReturnValueOnce(freshDiff.promise)

    await act(async () => root.render(<Probe activeFile={file} />))
    await vi.waitFor(() =>
      expect(snapshots.get('main')?.diffContents[file.id]?.modifiedContent).toBe('old diff')
    )

    await act(async () => root.render(<Probe activeFile={file} isVisible={false} />))
    dispatchExternalChange(file)
    // Why: the viewers render "Loading diff…" purely on a missing entry, so a
    // retained (stale-marked) entry is what keeps the pane painted.
    expect(snapshots.get('main')?.diffContents[file.id]?.modifiedContent).toBe('old diff')
    expect(snapshots.get('main')?.diffContents[file.id]?.isStale).toBe(true)
    expect(mocks.getRuntimeGitDiff).toHaveBeenCalledOnce()

    await act(async () => root.render(<Probe activeFile={file} />))
    await vi.waitFor(() => expect(mocks.getRuntimeGitDiff).toHaveBeenCalledTimes(2))
    expect(snapshots.get('main')?.diffContents[file.id]?.modifiedContent).toBe('old diff')

    await act(async () => {
      freshDiff.resolve(textDiff('fresh diff'))
      await freshDiff.promise
    })
    await vi.waitFor(() =>
      expect(snapshots.get('main')?.diffContents[file.id]).toEqual(textDiff('fresh diff'))
    )
    expect(mocks.getRuntimeGitDiff).toHaveBeenCalledTimes(2)
  })

  it('invalidates a hidden Git-status diff without reading until reveal', async () => {
    const file = makeFile('status', { mode: 'diff', diffSource: 'unstaged' })
    const status: GitStatusEntry[] = [
      { path: file.relativePath, status: 'modified', area: 'unstaged' }
    ]
    mocks.getRuntimeGitDiff
      .mockResolvedValueOnce(textDiff('old diff'))
      .mockResolvedValueOnce(textDiff('fresh diff'))

    await act(async () => root.render(<Probe activeFile={file} />))
    await vi.waitFor(() => expect(snapshots.get('main')?.diffContents[file.id]).toBeDefined())
    await act(async () =>
      root.render(<Probe activeFile={file} gitStatusEntries={status} isVisible={false} />)
    )
    expect(snapshots.get('main')?.diffContents[file.id]?.isStale).toBe(true)
    expect(mocks.getRuntimeGitDiff).toHaveBeenCalledOnce()

    await act(async () => root.render(<Probe activeFile={file} gitStatusEntries={status} />))
    await vi.waitFor(() =>
      expect(snapshots.get('main')?.diffContents[file.id]?.modifiedContent).toBe('fresh diff')
    )
    expect(mocks.getRuntimeGitDiff).toHaveBeenCalledTimes(2)
  })

  it('invalidates an inactive cached Changes diff after an external edit', async () => {
    const file = makeFile('changes-cache')
    const changesMode = { [file.id]: 'changes' as const }
    mocks.readRuntimeFileContent
      .mockResolvedValueOnce({ content: 'old', isBinary: false })
      .mockResolvedValueOnce({ content: 'fresh', isBinary: false })
    mocks.getRuntimeGitDiff
      .mockResolvedValueOnce(textDiff('old diff'))
      .mockResolvedValueOnce(textDiff('fresh diff'))

    await act(async () =>
      root.render(<Probe activeFile={file} editorViewMode={changesMode} isChangesMode />)
    )
    await vi.waitFor(() => expect(snapshots.get('main')?.diffContents[file.id]).toBeDefined())
    await act(async () => root.render(<Probe activeFile={file} />))

    dispatchExternalChange(file)
    await vi.waitFor(() => expect(mocks.readRuntimeFileContent).toHaveBeenCalledTimes(2))
    expect(mocks.getRuntimeGitDiff).toHaveBeenCalledOnce()
    expect(snapshots.get('main')?.diffContents[file.id]?.isStale).toBe(true)

    await act(async () =>
      root.render(<Probe activeFile={file} editorViewMode={changesMode} isChangesMode />)
    )
    await vi.waitFor(() =>
      expect(snapshots.get('main')?.diffContents[file.id]?.modifiedContent).toBe('fresh diff')
    )
    expect(mocks.getRuntimeGitDiff).toHaveBeenCalledTimes(2)
  })
})
