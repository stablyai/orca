// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type { DiffContent, FileContent } from './editor-panel-content-types'
import type { EditorPanelContentLoadOptions } from './useEditorPanelExternalContentEvents'

const mocks = vi.hoisted(() => ({ read: vi.fn(), diff: vi.fn() }))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ settings: {}, openFiles: [], editorDrafts: {} }) }
}))
vi.mock('@/lib/connection-context', () => ({
  getConnectionIdForFile: () => 'ssh-a',
  isWorktreeConnectionResolved: () => true
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ settingsForRuntimeOwner: () => null }))
vi.mock('@/runtime/runtime-file-client', () => ({
  getRuntimeFileReadScope: () => 'ssh-a',
  readRuntimeFileContent: mocks.read
}))
vi.mock('@/runtime/runtime-git-client', () => ({
  getRuntimeGitScope: () => 'ssh-a',
  getRuntimeGitDiff: mocks.diff
}))
import { useEditorPanelFileContentLoader } from './useEditorPanelFileContentLoader'
import { useEditorPanelDiffContentLoader } from './useEditorPanelDiffContentLoader'

const file: OpenFile = {
  id: 'file',
  filePath: '/repo/a.ts',
  relativePath: 'a.ts',
  worktreeId: 'wt',
  language: 'typescript',
  mode: 'edit',
  isDirty: true
}
const oldFile: FileContent = { content: 'old', isBinary: false }
const oldDiff: DiffContent = {
  kind: 'text',
  originalContent: 'base',
  modifiedContent: 'old',
  originalIsBinary: false,
  modifiedIsBinary: false
}
let files: Record<string, FileContent>
let diffs: Record<string, DiffContent>
let load: (options: EditorPanelContentLoadOptions) => Promise<void>
let root: Root
let container: HTMLDivElement
function Harness({ mode }: { mode: 'file' | 'diff' }): null {
  const readFile = useEditorPanelFileContentLoader({
    fileLoadRetryAttemptsRef: { current: {} },
    fileReadGenerationCounterRef: { current: 0 },
    fileReadGenerationRef: { current: {} },
    openFilesRef: { current: [file] },
    outstandingFileReadsRef: { current: {} },
    setFileContents: (update) => {
      files = typeof update === 'function' ? update(files) : update
    }
  })
  const readDiff = useEditorPanelDiffContentLoader({
    diffReadGenerationCounterRef: { current: 0 },
    diffReadGenerationRef: { current: {} },
    outstandingDiffReadsRef: { current: {} },
    setDiffContents: (update) => {
      diffs = typeof update === 'function' ? update(diffs) : update
    }
  })
  load =
    mode === 'file'
      ? (options) => readFile(file.filePath, file.id, file.worktreeId, file.relativePath, options)
      : (options) => readDiff({ ...file, mode: 'diff', diffSource: 'unstaged' }, options)
  return null
}
beforeEach(() => {
  mocks.read.mockReset()
  mocks.diff.mockReset()
  files = { file: oldFile }
  diffs = { file: oldDiff }
  container = document.createElement('div')
  root = createRoot(container)
})
afterEach(() => act(() => root.unmount()))

describe.each(['file', 'diff'] as const)('%s manual reload loader', (mode) => {
  it('preserves displayed content and the draft on remote read failure', async () => {
    mocks.read.mockRejectedValue(new Error('Disconnected'))
    mocks.diff.mockRejectedValue(new Error('Disconnected'))
    act(() => root.render(<Harness mode={mode} />))
    const beforeApply = vi.fn(() => true)
    const onError = vi.fn()
    await load({ force: true, beforeApply, onError })
    expect(beforeApply).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledOnce()
    expect(files.file).toBe(oldFile)
    expect(diffs.file).toBe(oldDiff)
  })
  it('does not discard a draft when disk content became binary', async () => {
    mocks.read.mockResolvedValue({ content: '', isBinary: true })
    mocks.diff.mockResolvedValue({ ...oldDiff, modifiedIsBinary: true })
    act(() => root.render(<Harness mode={mode} />))
    const beforeApply = vi.fn(() => true)
    const onError = vi.fn()
    await load({ force: true, beforeApply, onError })
    expect(beforeApply).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledOnce()
    expect(files.file).toBe(oldFile)
    expect(diffs.file).toBe(oldDiff)
  })
  it('cancels replacement when newer editor work wins the transaction', async () => {
    mocks.read.mockResolvedValue({ content: 'new', isBinary: false })
    mocks.diff.mockResolvedValue({ ...oldDiff, modifiedContent: 'new' })
    act(() => root.render(<Harness mode={mode} />))
    const beforeApply = vi.fn(() => false)
    await load({ force: true, beforeApply })
    expect(beforeApply).toHaveBeenCalledOnce()
    expect(files.file).toBe(oldFile)
    expect(diffs.file).toBe(oldDiff)
  })
  it('commits a successful read after approving the draft discard', async () => {
    mocks.read.mockResolvedValue({ content: 'new', isBinary: false })
    mocks.diff.mockResolvedValue({ ...oldDiff, modifiedContent: 'new' })
    act(() => root.render(<Harness mode={mode} />))
    const beforeApply = vi.fn(() => true)
    await load({ force: true, beforeApply })
    expect(beforeApply).toHaveBeenCalledOnce()
    expect(
      mode === 'file'
        ? files.file?.content
        : diffs.file?.kind === 'text' && diffs.file.modifiedContent
    ).toBe('new')
  })
})
