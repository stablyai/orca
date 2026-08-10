// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import type { editor } from 'monaco-editor'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LargeDiffRenderLimit } from '../../../../../shared/large-diff-render-limit'
import type {
  GitDiffResult,
  GitStatusEntry,
  GlobalSettings,
  Repo,
  Worktree
} from '../../../../../shared/types'

const getRuntimeGitDiffMock = vi.hoisted(() => vi.fn())
const toastMock = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), warning: vi.fn() }))
const storeState = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))
// Why: keyed lookups, not constants — the doubles must prove the hook resolves the FILE's worktree
// and routes that worktree's SSH connection, which argument-blind stubs cannot pin.
const storeDoubles = vi.hoisted(() => ({
  worktrees: new Map<string, unknown>(),
  repos: new Map<string, unknown>(),
  connectionIdByWorktreeId: new Map<string, string>()
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(storeState.current),
    { getState: () => storeState.current }
  )
}))
vi.mock('@/store/selectors', () => ({
  useWorktreeById: (worktreeId: string | null) =>
    worktreeId ? (storeDoubles.worktrees.get(worktreeId) ?? null) : null,
  useRepoMap: () => storeDoubles.repos
}))
vi.mock('@/runtime/runtime-git-client', () => ({ getRuntimeGitDiff: getRuntimeGitDiffMock }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  settingsForRuntimeOwner: (
    settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
    runtimeEnvironmentId: string | null | undefined
  ) => (runtimeEnvironmentId ? { activeRuntimeEnvironmentId: runtimeEnvironmentId } : settings)
}))
vi.mock('@/lib/connection-context', () => ({
  getConnectionIdForFile: (worktreeId: string) =>
    storeDoubles.connectionIdByWorktreeId.get(worktreeId) ?? null
}))
vi.mock('sonner', () => ({ toast: toastMock }))

import {
  GIT_GUTTER_DEBOUNCE_MS,
  GIT_GUTTER_MAX_WAIT_MS,
  useEditorGitGutter
} from './useEditorGitGutter'

const FILE_ID = '/repo/wt/src/a.ts'
const WORKTREE_ID = 'repo-1::wt'
const OTHER_WORKTREE_ID = 'repo-2::wt'
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

function textDiffResult(
  originalContent: string,
  largeDiffRenderLimit?: LargeDiffRenderLimit
): GitDiffResult {
  return {
    kind: 'text',
    originalContent,
    modifiedContent: '',
    originalIsBinary: false,
    modifiedIsBinary: false,
    largeDiffRenderLimit
  }
}

type StoreOverrides = {
  statusEntries?: GitStatusEntry[]
  headSha?: string
  gutterEnabled?: boolean
  runtimeEnvironmentId?: string
}

function setStore(overrides: StoreOverrides = {}): void {
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
        mode: 'edit',
        runtimeEnvironmentId: overrides.runtimeEnvironmentId
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

async function advance(milliseconds: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds)
  })
}

async function settle(): Promise<void> {
  await flushBaseline()
  await advance(GIT_GUTTER_DEBOUNCE_MS)
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
  storeDoubles.worktrees.clear()
  storeDoubles.repos.clear()
  storeDoubles.connectionIdByWorktreeId.clear()
  storeDoubles.worktrees.set(WORKTREE_ID, {
    id: WORKTREE_ID,
    repoId: 'repo-1',
    path: '/repo/wt'
  } as unknown as Worktree)
  storeDoubles.repos.set('repo-1', { id: 'repo-1', kind: 'git' } as unknown as Repo)
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
      {
        settings: { activeRuntimeEnvironmentId: null },
        worktreeId: WORKTREE_ID,
        worktreePath: '/repo/wt',
        connectionId: undefined
      },
      { filePath: 'src/a.ts', staged: false, compareAgainstHead: true }
    )
    expect(decorationsCollection.set).toHaveBeenLastCalledWith([MODIFIED_LINE_TWO_DECORATION])
  })

  it('routes the read through the file worktree ssh connection and runtime owner', async () => {
    storeDoubles.connectionIdByWorktreeId.set(WORKTREE_ID, 'ssh-target-1')
    setStore({ runtimeEnvironmentId: 'env-7' })
    render(<GutterHarness content={MODIFIED} />)
    await settle()

    expect(getRuntimeGitDiffMock).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'ssh-target-1',
        settings: { activeRuntimeEnvironmentId: 'env-7' }
      }),
      expect.anything()
    )
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
      await advance(GIT_GUTTER_DEBOUNCE_MS)
    }

    expect(getRuntimeGitDiffMock).toHaveBeenCalledTimes(1)
  })

  it('keeps repainting through edits arriving faster than the debounce window', async () => {
    const { rerender } = render(<GutterHarness content={BASELINE} />)
    await settle()
    const paintsBeforeBurst = decorationsCollection.set.mock.calls.length

    // Changes spaced under the debounce — a sustained agent write. Trailing-only starves: every
    // change cancels the pending timer, so nothing repaints until the burst ends seconds later.
    const changeCount = 40
    const changeIntervalMs = GIT_GUTTER_DEBOUNCE_MS - 50
    for (let change = 0; change < changeCount; change += 1) {
      rerender(<GutterHarness content={`${BASELINE}\nadded-${change}`} />)
      await advance(changeIntervalMs)
    }
    const paintsDuringBurst = decorationsCollection.set.mock.calls.length - paintsBeforeBurst
    await advance(GIT_GUTTER_DEBOUNCE_MS)

    // One paint per maxWait window, minus a slot of slack for where the burst lands in it.
    const owedPaints = Math.floor((changeCount * changeIntervalMs) / GIT_GUTTER_MAX_WAIT_MS) - 1
    expect(paintsDuringBurst).toBeGreaterThanOrEqual(owedPaints)
    expect(decorationsCollection.set).toHaveBeenLastCalledWith([
      {
        range: { startLineNumber: 4, startColumn: 1, endLineNumber: 4, endColumn: 1 },
        options: {
          isWholeLine: true,
          linesDecorationsClassName: 'orca-git-gutter orca-git-gutter-added'
        }
      }
    ])
  })

  it('paints a fresh baseline on the leading edge instead of waiting out the debounce', async () => {
    render(<GutterHarness content={MODIFIED} />)
    await flushBaseline()
    await advance(1)

    expect(decorationsCollection.set).toHaveBeenCalledTimes(1)
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

  it('rebuilds the collection when the editor instance is swapped', async () => {
    const { rerender } = render(<GutterHarness content={MODIFIED} />)
    await settle()
    const firstCollection = decorationsCollection

    decorationsCollection = { set: vi.fn(), clear: vi.fn() }
    editorInstance = {
      createDecorationsCollection: vi.fn(() => decorationsCollection)
    } as unknown as editor.IStandaloneCodeEditor
    rerender(<GutterHarness content={MODIFIED} />)
    await settle()

    expect(firstCollection.clear).toHaveBeenCalled()
    expect(decorationsCollection.set).toHaveBeenLastCalledWith([MODIFIED_LINE_TWO_DECORATION])
  })

  it('does nothing when the gutter setting is off', async () => {
    setStore({ gutterEnabled: false })
    render(<GutterHarness content={MODIFIED} />)
    await settle()

    expect(getRuntimeGitDiffMock).not.toHaveBeenCalled()
    expect(decorationsCollection.set).not.toHaveBeenCalled()
  })

  it('paints an untracked file as entirely added', async () => {
    // Why: HEAD has no blob at the path, so git returns an empty original and every line is new.
    setStore({ statusEntries: [{ path: 'src/a.ts', status: 'untracked', area: 'untracked' }] })
    getRuntimeGitDiffMock.mockResolvedValue(textDiffResult(''))
    render(<GutterHarness content={'a\nb\nc'} />)
    await settle()

    expect(getRuntimeGitDiffMock).toHaveBeenCalledTimes(1)
    expect(decorationsCollection.set).toHaveBeenLastCalledWith([
      {
        range: { startLineNumber: 1, startColumn: 1, endLineNumber: 3, endColumn: 1 },
        options: {
          isWholeLine: true,
          linesDecorationsClassName: 'orca-git-gutter orca-git-gutter-added'
        }
      }
    ])
  })

  it('does not read git while the path is an unresolved conflict', async () => {
    setStore({
      statusEntries: [
        {
          path: 'src/a.ts',
          status: 'modified',
          area: 'unstaged',
          conflictKind: 'both_modified',
          conflictStatus: 'unresolved'
        }
      ]
    })
    render(<GutterHarness content={MODIFIED} />)
    await settle()

    expect(getRuntimeGitDiffMock).not.toHaveBeenCalled()
    expect(decorationsCollection.set).not.toHaveBeenCalled()
  })

  it('keeps painting a file whose text merely looks like conflict markers', async () => {
    const setextHeading = 'Summary\n=======\nbody'
    getRuntimeGitDiffMock.mockResolvedValue(textDiffResult('Summary\n=======\nold body'))
    render(<GutterHarness content={setextHeading} />)
    await settle()

    expect(getRuntimeGitDiffMock).toHaveBeenCalledTimes(1)
    expect(decorationsCollection.set).toHaveBeenLastCalledWith([
      {
        range: { startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 1 },
        options: {
          isWholeLine: true,
          linesDecorationsClassName: 'orca-git-gutter orca-git-gutter-modified'
        }
      }
    ])
  })

  it('paints nothing for a binary file', async () => {
    getRuntimeGitDiffMock.mockResolvedValue({
      kind: 'binary',
      originalContent: '',
      modifiedContent: '',
      originalIsBinary: true,
      modifiedIsBinary: true
    } satisfies GitDiffResult)
    render(<GutterHarness content={MODIFIED} />)
    await settle()

    expect(getRuntimeGitDiffMock).toHaveBeenCalledTimes(1)
    expect(decorationsCollection.set).not.toHaveBeenCalled()
  })

  it('paints nothing when the diff came back over the render limit', async () => {
    getRuntimeGitDiffMock.mockResolvedValue(
      textDiffResult('', {
        limited: true,
        reason: 'line-count',
        lineCounts: { original: 900_000, modified: 900_000 },
        characterCount: 9_000_000,
        limits: { maxLinesPerSide: 120_000, maxCombinedCharacters: 6_000_000 }
      })
    )
    render(<GutterHarness content={MODIFIED} />)
    await settle()

    expect(getRuntimeGitDiffMock).toHaveBeenCalledTimes(1)
    expect(decorationsCollection.set).not.toHaveBeenCalled()
  })

  it('still paints when the host reports the diff was within the render limit', async () => {
    getRuntimeGitDiffMock.mockResolvedValue(
      textDiffResult(BASELINE, {
        limited: false,
        lineCounts: { original: 3, modified: 3 },
        characterCount: 40
      })
    )
    render(<GutterHarness content={MODIFIED} />)
    await settle()

    expect(decorationsCollection.set).toHaveBeenLastCalledWith([MODIFIED_LINE_TWO_DECORATION])
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
    storeDoubles.repos.set('repo-1', { id: 'repo-1', kind: 'folder' } as unknown as Repo)
    // Why: a git-backed repo elsewhere in the store must not leak in — the gate is the file's own.
    storeDoubles.worktrees.set(OTHER_WORKTREE_ID, {
      id: OTHER_WORKTREE_ID,
      repoId: 'repo-2',
      path: '/repo/other'
    } as unknown as Worktree)
    storeDoubles.repos.set('repo-2', { id: 'repo-2', kind: 'git' } as unknown as Repo)
    setStore({ statusEntries: [] })
    render(<GutterHarness content={MODIFIED} />)
    await settle()

    expect(getRuntimeGitDiffMock).not.toHaveBeenCalled()
    expect(decorationsCollection.set).not.toHaveBeenCalled()
  })
})
