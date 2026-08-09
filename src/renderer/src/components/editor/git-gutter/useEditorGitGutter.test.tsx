// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import type { editor } from 'monaco-editor'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitStatusEntry, Repo, Worktree } from '../../../../../shared/types'

const getRuntimeGitDiffMock = vi.hoisted(() => vi.fn())
const toastMock = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), warning: vi.fn() }))
const storeState = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))
const selectorState = vi.hoisted(() => ({
  worktree: null as unknown,
  repo: null as unknown
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(storeState.current),
    { getState: () => storeState.current }
  )
}))
vi.mock('@/store/selectors', () => ({
  useWorktreeById: () => selectorState.worktree,
  useRepoById: () => selectorState.repo
}))
vi.mock('@/runtime/runtime-git-client', () => ({ getRuntimeGitDiff: getRuntimeGitDiffMock }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  settingsForRuntimeOwner: (settings: unknown) => settings
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => null }))
vi.mock('sonner', () => ({ toast: toastMock }))

import { GIT_GUTTER_DEBOUNCE_MS, useEditorGitGutter } from './useEditorGitGutter'

const FILE_ID = '/repo/wt/src/a.ts'
const WORKTREE_ID = 'repo-1::wt'
const BASELINE = 'alpha\nbravo\ncharlie'
const MODIFIED = 'alpha\nBRAVO\ncharlie'

const MODIFIED_LINE_TWO_DECORATION = {
  range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 1 },
  options: {
    isWholeLine: true,
    linesDecorationsClassName: 'orca-git-gutter orca-git-gutter-modified'
  }
}

let decorationsCollection: { set: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn> }
let editorInstance: editor.IStandaloneCodeEditor

function textDiffResult(originalContent: string, extra: Record<string, unknown> = {}): unknown {
  return {
    kind: 'text',
    originalContent,
    modifiedContent: '',
    originalIsBinary: false,
    modifiedIsBinary: false,
    ...extra
  }
}

function setStore(
  overrides: { statusEntries?: GitStatusEntry[]; headSha?: string; gutterEnabled?: boolean } = {}
): void {
  storeState.current = {
    settings: {
      activeRuntimeEnvironmentId: null,
      ...(overrides.gutterEnabled === undefined ? {} : { editorGitGutter: overrides.gutterEnabled })
    },
    openFiles: [
      {
        id: FILE_ID,
        filePath: FILE_ID,
        relativePath: 'src/a.ts',
        worktreeId: WORKTREE_ID,
        language: 'typescript',
        isDirty: false,
        mode: 'edit'
      }
    ],
    gitStatusByWorktree: {
      [WORKTREE_ID]: overrides.statusEntries ?? [
        { path: 'src/a.ts', status: 'modified', area: 'unstaged' }
      ]
    },
    gitStatusHeadByWorktree: { [WORKTREE_ID]: overrides.headSha ?? 'head-1' }
  }
}

function GutterHarness({ content, fileId = FILE_ID }: { content: string; fileId?: string }): null {
  useEditorGitGutter({ editorInstance, fileId, content })
  return null
}

async function flushBaseline(): Promise<void> {
  await act(async () => {
    for (let tick = 0; tick < 5; tick += 1) {
      await Promise.resolve()
    }
  })
}

async function runDebounce(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(GIT_GUTTER_DEBOUNCE_MS)
  })
}

async function settle(): Promise<void> {
  await flushBaseline()
  await runDebounce()
}

beforeEach(() => {
  vi.useFakeTimers()
  decorationsCollection = { set: vi.fn(), clear: vi.fn() }
  editorInstance = {
    createDecorationsCollection: vi.fn(() => decorationsCollection)
  } as unknown as editor.IStandaloneCodeEditor
  getRuntimeGitDiffMock.mockReset()
  getRuntimeGitDiffMock.mockResolvedValue(textDiffResult(BASELINE))
  toastMock.mockReset()
  toastMock.error.mockReset()
  toastMock.warning.mockReset()
  selectorState.worktree = {
    id: WORKTREE_ID,
    repoId: 'repo-1',
    path: '/repo/wt'
  } as unknown as Worktree
  selectorState.repo = { id: 'repo-1', kind: 'git' } as unknown as Repo
  setStore()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('useEditorGitGutter', () => {
  it('fetches the HEAD baseline once and paints the changed line', async () => {
    render(<GutterHarness content={MODIFIED} />)
    await settle()

    expect(getRuntimeGitDiffMock).toHaveBeenCalledTimes(1)
    expect(getRuntimeGitDiffMock).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: WORKTREE_ID, worktreePath: '/repo/wt' }),
      { filePath: 'src/a.ts', staged: false, compareAgainstHead: true }
    )
    expect(decorationsCollection.set).toHaveBeenLastCalledWith([MODIFIED_LINE_TWO_DECORATION])
  })

  it('performs no git read across a burst of content changes', async () => {
    const { rerender } = render(<GutterHarness content={BASELINE} />)
    await settle()
    expect(getRuntimeGitDiffMock).toHaveBeenCalledTimes(1)

    for (const keystroke of [
      'alpha\nb',
      'alpha\nbr',
      'alpha\nbra',
      'alpha\nbrav',
      'alpha\nbravo'
    ]) {
      rerender(<GutterHarness content={keystroke} />)
      await runDebounce()
    }

    expect(getRuntimeGitDiffMock).toHaveBeenCalledTimes(1)
  })

  it('refetches when the worktree HEAD moves', async () => {
    const { rerender } = render(<GutterHarness content={MODIFIED} />)
    await settle()
    expect(getRuntimeGitDiffMock).toHaveBeenCalledTimes(1)

    setStore({ headSha: 'head-2' })
    rerender(<GutterHarness content={MODIFIED} />)
    await settle()

    expect(getRuntimeGitDiffMock).toHaveBeenCalledTimes(2)
  })

  it('keeps the painted marks while a refetch is still in flight', async () => {
    const { rerender } = render(<GutterHarness content={MODIFIED} />)
    await settle()
    const paintedBeforeRefetch = decorationsCollection.set.mock.calls.at(-1)

    getRuntimeGitDiffMock.mockReturnValue(new Promise(() => {}))
    setStore({ headSha: 'head-2' })
    rerender(<GutterHarness content={MODIFIED} />)
    await settle()

    expect(paintedBeforeRefetch).toEqual([[MODIFIED_LINE_TWO_DECORATION]])
    expect(getRuntimeGitDiffMock).toHaveBeenCalledTimes(2)
    expect(decorationsCollection.clear).not.toHaveBeenCalled()
    expect(decorationsCollection.set.mock.calls.at(-1)).toEqual(paintedBeforeRefetch)
  })

  it('drops the baseline when the same hook instance switches to another file', async () => {
    const { rerender } = render(<GutterHarness content={MODIFIED} />)
    await settle()
    expect(decorationsCollection.set).toHaveBeenCalledTimes(1)

    getRuntimeGitDiffMock.mockReturnValue(new Promise(() => {}))
    setStore()
    ;(storeState.current.openFiles as unknown[]).push({
      id: '/repo/wt/src/b.ts',
      filePath: '/repo/wt/src/b.ts',
      relativePath: 'src/b.ts',
      worktreeId: WORKTREE_ID,
      language: 'typescript',
      isDirty: false,
      mode: 'edit'
    })
    rerender(<GutterHarness content={MODIFIED} fileId="/repo/wt/src/b.ts" />)
    await settle()

    expect(decorationsCollection.clear).toHaveBeenCalled()
    expect(decorationsCollection.set).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the gutter setting is off', async () => {
    setStore({ gutterEnabled: false })
    render(<GutterHarness content={MODIFIED} />)
    await settle()

    expect(getRuntimeGitDiffMock).not.toHaveBeenCalled()
    expect(decorationsCollection.set).not.toHaveBeenCalled()
  })

  it('does not read git for an untracked file', async () => {
    setStore({ statusEntries: [{ path: 'src/a.ts', status: 'untracked', area: 'untracked' }] })
    render(<GutterHarness content={MODIFIED} />)
    await settle()

    expect(getRuntimeGitDiffMock).not.toHaveBeenCalled()
    expect(decorationsCollection.set).not.toHaveBeenCalled()
  })

  it('paints nothing for a binary file', async () => {
    getRuntimeGitDiffMock.mockResolvedValue({
      kind: 'binary',
      originalContent: '',
      modifiedContent: '',
      originalIsBinary: true,
      modifiedIsBinary: true
    })
    render(<GutterHarness content={MODIFIED} />)
    await settle()

    expect(getRuntimeGitDiffMock).toHaveBeenCalledTimes(1)
    expect(decorationsCollection.set).not.toHaveBeenCalled()
  })

  it('paints nothing when the diff came back over the render limit', async () => {
    getRuntimeGitDiffMock.mockResolvedValue(
      textDiffResult('', { largeDiffRenderLimit: { kind: 'lines', limit: 20000, actual: 90000 } })
    )
    render(<GutterHarness content={MODIFIED} />)
    await settle()

    expect(getRuntimeGitDiffMock).toHaveBeenCalledTimes(1)
    expect(decorationsCollection.set).not.toHaveBeenCalled()
  })

  it('drops the marks silently when the git read fails', async () => {
    getRuntimeGitDiffMock.mockRejectedValue(new Error('ssh host went away'))
    render(<GutterHarness content={MODIFIED} />)
    await settle()

    expect(getRuntimeGitDiffMock).toHaveBeenCalledTimes(1)
    expect(decorationsCollection.set).not.toHaveBeenCalled()
    expect(toastMock).not.toHaveBeenCalled()
    expect(toastMock.error).not.toHaveBeenCalled()
  })

  it('does not read git in a folder workspace with no repository', async () => {
    selectorState.repo = { id: 'repo-1', kind: 'folder' } as unknown as Repo
    setStore({ statusEntries: [] })
    render(<GutterHarness content={MODIFIED} />)
    await settle()

    expect(getRuntimeGitDiffMock).not.toHaveBeenCalled()
    expect(decorationsCollection.set).not.toHaveBeenCalled()
  })
})
