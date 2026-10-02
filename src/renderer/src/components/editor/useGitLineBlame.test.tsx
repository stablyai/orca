// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import type { editor } from 'monaco-editor'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitBlameResult } from '../../../../shared/git-blame'

const mocks = vi.hoisted(() => ({ getRuntimeGitBlame: vi.fn() }))

vi.mock('@/runtime/runtime-git-client', () => ({ getRuntimeGitBlame: mocks.getRuntimeGitBlame }))
vi.mock('@/lib/monaco-setup', () => ({
  monaco: {
    editor: {
      EditorOption: { readOnly: 'readOnly', fontInfo: 'fontInfo', lineHeight: 'lineHeight' },
      ContentWidgetPositionPreference: { EXACT: 0 },
      PositionAffinity: { Right: 1 }
    }
  }
}))
vi.mock('@/store', () => {
  const state = { worktreesByRepo: {}, repos: [], settings: null, gitStatusHeadByWorktree: {} }
  const useAppStore = (selector: (s: typeof state) => unknown): unknown => selector(state)
  useAppStore.getState = () => state
  return { useAppStore }
})
vi.mock('@/store/slices/worktree-helpers', () => ({
  findWorktreeById: () => ({ path: '/repo', repoId: 'repo' })
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => null }))
vi.mock('@/lib/repo-runtime-owner', () => ({ getRepoOwnerRoutedSettings: () => null }))
vi.mock('@/lib/open-git-blame-commit-diff', () => ({ openGitBlameCommitDiff: vi.fn() }))

import { useGitLineBlame } from './useGitLineBlame'

type FakeModel = {
  version: number
  getAlternativeVersionId: () => number
  getLineCount: () => number
  getLineMaxColumn: () => number
}

function makeModel(): FakeModel {
  const model: FakeModel = {
    version: 1,
    getAlternativeVersionId: () => model.version,
    getLineCount: () => 3,
    getLineMaxColumn: () => 10
  }
  return model
}

function createFakeEditor(readOnly: boolean) {
  const content = new Set<() => void>()
  const modelChange = new Set<() => void>()
  const focus = new Set<() => void>()
  let model: FakeModel | null = makeModel()
  let widget: editor.IContentWidget | null = null
  const subscribe = (set: Set<() => void>) => (cb: () => void) => {
    set.add(cb)
    return { dispose: () => set.delete(cb) }
  }
  const fake = {
    addContentWidget: (w: editor.IContentWidget) => {
      widget = w
    },
    removeContentWidget: () => {},
    layoutContentWidget: () => {},
    getModel: () => model,
    getPosition: () => ({ lineNumber: 1, column: 1 }),
    getOption: (key: string) =>
      key === 'readOnly' ? readOnly : key === 'fontInfo' ? { fontFamily: 'x', fontSize: 12 } : 18,
    onDidChangeCursorPosition: subscribe(new Set()),
    onDidChangeConfiguration: subscribe(new Set()),
    onDidChangeModelContent: subscribe(content),
    onDidChangeModel: subscribe(modelChange),
    onDidFocusEditorText: subscribe(focus)
  }
  return {
    editor: fake as unknown as editor.ICodeEditor,
    annotation: () => widget?.getDomNode().textContent ?? '',
    mutateContent: () => {
      model!.version += 1
      content.forEach((cb) => cb())
    },
    focusText: () => focus.forEach((cb) => cb()),
    swapModel: () => {
      model = makeModel()
      modelChange.forEach((cb) => cb())
    }
  }
}

function blameFor(author: string): GitBlameResult {
  return {
    status: 'ready',
    lines: [{ line: 1, commitOid: 'a'.repeat(40), author, authorTime: 0, summary: '' }]
  }
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

describe('useGitLineBlame', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.getRuntimeGitBlame.mockReset()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  function mount(fake: ReturnType<typeof createFakeEditor>, relativePath = 'a.ts') {
    renderHook(() =>
      useGitLineBlame({
        editor: fake.editor,
        enabled: true,
        worktreeId: 'repo::/repo',
        relativePath
      })
    )
  }

  it('re-blames a read-only model after its content changes', async () => {
    mocks.getRuntimeGitBlame
      .mockResolvedValueOnce(blameFor('Ada'))
      .mockResolvedValueOnce(blameFor('Grace'))
    const fake = createFakeEditor(true)
    mount(fake)
    await advance(200)
    expect(fake.annotation()).toContain('Ada')

    fake.mutateContent()
    expect(fake.annotation()).toBe('')
    await advance(200)
    expect(mocks.getRuntimeGitBlame).toHaveBeenCalledTimes(2)
    expect(fake.annotation()).toContain('Grace')
  })

  it('does not re-blame an editable model until it is saved', async () => {
    mocks.getRuntimeGitBlame.mockResolvedValue(blameFor('Ada'))
    const fake = createFakeEditor(false)
    mount(fake)
    await advance(200)

    fake.mutateContent()
    await advance(200)
    expect(mocks.getRuntimeGitBlame).toHaveBeenCalledTimes(1)
    expect(fake.annotation()).toBe('')
  })

  it('re-blames when the editor swaps to a new model without remounting', async () => {
    mocks.getRuntimeGitBlame
      .mockResolvedValueOnce(blameFor('Ada'))
      .mockResolvedValueOnce(blameFor('Grace'))
    const fake = createFakeEditor(false)
    mount(fake)
    await advance(200)
    expect(fake.annotation()).toContain('Ada')

    fake.swapModel()
    expect(fake.annotation()).toBe('')
    await advance(200)
    expect(mocks.getRuntimeGitBlame).toHaveBeenCalledTimes(2)
    expect(fake.annotation()).toContain('Grace')
  })

  it('drops a blame result that resolves after the model was swapped', async () => {
    let resolveFirst!: (result: GitBlameResult) => void
    mocks.getRuntimeGitBlame
      .mockReturnValueOnce(new Promise<GitBlameResult>((resolve) => (resolveFirst = resolve)))
      .mockResolvedValueOnce(blameFor('Grace'))
    const fake = createFakeEditor(false)
    mount(fake)
    await advance(100)

    fake.swapModel()
    await advance(200)
    await act(async () => resolveFirst(blameFor('Ada')))
    expect(fake.annotation()).toContain('Grace')
  })

  it('starts a focused pane ahead of older queued panes', async () => {
    const gates: ((result: GitBlameResult) => void)[] = []
    mocks.getRuntimeGitBlame.mockImplementation(
      () => new Promise<GitBlameResult>((resolve) => gates.push(resolve))
    )
    const fakes = ['running-1.ts', 'running-2.ts', 'older.ts', 'focused.ts'].map((path) => {
      const fake = createFakeEditor(true)
      mount(fake, path)
      return fake
    })
    await advance(200)
    const startedPaths = (): string[] => mocks.getRuntimeGitBlame.mock.calls.map((call) => call[1])
    expect(startedPaths()).toEqual(['running-1.ts', 'running-2.ts'])

    fakes[3]!.focusText()
    gates[0]!(blameFor('Ada'))
    await advance(10)
    expect(startedPaths()).toEqual(['running-1.ts', 'running-2.ts', 'focused.ts'])

    gates.forEach((resolve) => resolve(blameFor('Ada')))
    await advance(10)
  })
})
