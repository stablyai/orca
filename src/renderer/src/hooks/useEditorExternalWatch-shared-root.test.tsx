// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type * as WatchTargets from './editor-external-watch-targets'

type TestWatchTarget = {
  worktreeId: string
  worktreePath: string
  connectionId: string | undefined
  runtimeEnvironmentId: string | null
}

const harness = vi.hoisted(() => {
  const targets: TestWatchTarget[] = []
  const unwatched: TestWatchTarget[] = []
  const openFiles: Record<string, unknown>[] = []
  return {
    keyOf: (target: TestWatchTarget): string =>
      `${target.worktreeId}::${target.runtimeEnvironmentId ?? 'client'}`,
    targets,
    unwatched,
    openFiles,
    setExternalMutation: vi.fn()
  }
})

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector({}), {
    getState: () => ({
      openFiles: harness.openFiles,
      setExternalMutation: harness.setExternalMutation
    })
  })
}))
vi.mock('./editor-external-watch-targets', async (importOriginal) => ({
  ...(await importOriginal<typeof WatchTargets>()),
  selectEditorExternalWatchTargets: () => ({
    targets: [...harness.targets],
    targetsKey: harness.targets.map(harness.keyOf).join('|'),
    unwatchedTargetKeys: new Set(harness.unwatched.map(harness.keyOf)),
    unwatchedTargetsKey: harness.unwatched.map(harness.keyOf).join('|')
  }),
  getEditorExternalWatchTargetKey: harness.keyOf
}))
vi.mock('./editor-runtime-file-watch', () => ({
  // Why: a shared runtime watch that is already ready reports it synchronously during subscribe.
  subscribeEditorRuntimeFileWatch: (
    _target: unknown,
    _onPayload: unknown,
    _onError: unknown,
    onFirstReady?: () => void
  ) => {
    onFirstReady?.()
    return vi.fn()
  }
}))

import { useEditorExternalWatch } from './useEditorExternalWatch'
import { ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT } from '@/components/editor/editor-autosave'

function WatchProbe(): null {
  useEditorExternalWatch()
  return null
}

function tab(worktreeId: string, relativePath: string, runtimeEnvironmentId?: string) {
  return {
    id: `/shared/${worktreeId}/${relativePath}`,
    filePath: `/shared/${relativePath}`,
    relativePath,
    worktreeId,
    language: 'typescript',
    mode: 'edit',
    isDirty: false,
    lastKnownDiskSignature: 'sig',
    ...(runtimeEnvironmentId ? { runtimeEnvironmentId } : {})
  }
}

describe('useEditorExternalWatch resync through the real reconciliation path', () => {
  let container: HTMLDivElement
  let root: Root
  let previousApi: unknown
  let emitFsChanged: (payload: unknown) => void
  let reloads: string[]
  const onReload = (event: Event): void => {
    if (event instanceof CustomEvent) {
      reloads.push(`${event.detail.worktreeId}:${event.detail.relativePath}`)
    }
  }

  async function render(targets: TestWatchTarget[], unwatched: TestWatchTarget[]): Promise<void> {
    harness.targets.splice(0, harness.targets.length, ...targets)
    harness.unwatched.splice(0, harness.unwatched.length, ...unwatched)
    await act(async () => root.render(createElement(WatchProbe)))
  }

  beforeEach(() => {
    vi.useFakeTimers()
    reloads = []
    harness.openFiles.splice(0)
    harness.setExternalMutation.mockClear()
    previousApi = (window as unknown as { api?: unknown }).api
    ;(window as unknown as { api: unknown }).api = {
      fs: {
        watchWorktree: vi.fn().mockResolvedValue(undefined),
        unwatchWorktree: vi.fn().mockResolvedValue(undefined),
        onFsChanged: vi.fn((listener: (payload: unknown) => void) => {
          emitFsChanged = listener
          return vi.fn()
        })
      }
    }
    window.addEventListener(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, onReload)
    container = document.body.appendChild(document.createElement('div'))
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    window.removeEventListener(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, onReload)
    container.remove()
    ;(window as unknown as { api?: unknown }).api = previousApi
    vi.useRealTimers()
  })

  it('reloads clean tabs of every workspace that shares the root', async () => {
    const a = {
      worktreeId: 'folder:a',
      worktreePath: '/shared',
      connectionId: undefined,
      runtimeEnvironmentId: null
    }
    const b = { ...a, worktreeId: 'folder:b' }
    harness.openFiles.push(tab('folder:a', 'a.ts'), tab('folder:b', 'b.ts'))
    await render([a, b], [])

    emitFsChanged({
      worktreePath: '/shared',
      events: [{ kind: 'overflow', absolutePath: '/shared' }]
    })
    await act(async () => vi.advanceTimersByTimeAsync(200))

    expect(reloads.sort()).toEqual(['folder:a:a.ts', 'folder:b:b.ts'])
  })

  it('resyncs a runtime workspace whose shared watch reports ready synchronously', async () => {
    const runtimeTarget = {
      worktreeId: 'wt-runtime',
      worktreePath: '/shared',
      connectionId: undefined,
      runtimeEnvironmentId: 'env-1'
    }
    harness.openFiles.push(tab('wt-runtime', 'r.ts', 'env-1'))
    await render([], [runtimeTarget])
    await render([runtimeTarget], [])
    await act(async () => vi.advanceTimersByTimeAsync(200))

    expect(reloads).toEqual(['wt-runtime:r.ts'])
  })

  it('resyncs only the re-added workspace, leaving another on the same root alone', async () => {
    const a = {
      worktreeId: 'folder:a',
      worktreePath: '/shared',
      connectionId: undefined,
      runtimeEnvironmentId: null
    }
    const b = { ...a, worktreeId: 'folder:b' }
    harness.openFiles.push(tab('folder:a', 'a.ts'), tab('folder:b', 'b.ts'), {
      ...tab('folder:b', 'gone.ts'),
      externalMutation: 'deleted'
    })
    await render([b], [a])
    await render([a, b], [])
    await act(async () => vi.advanceTimersByTimeAsync(200))

    expect(reloads).toEqual(['folder:a:a.ts'])
    expect(harness.setExternalMutation).not.toHaveBeenCalled()
  })

  it('keeps a local and an SSH workspace at the same path apart', async () => {
    const local = {
      worktreeId: 'local-wt',
      worktreePath: '/shared',
      connectionId: undefined,
      runtimeEnvironmentId: null
    }
    const ssh = { ...local, worktreeId: 'ssh-wt', connectionId: 'ssh-1' }
    harness.openFiles.push(tab('local-wt', 'x.ts'), tab('ssh-wt', 'x.ts'))
    await render([local, ssh], [])

    emitFsChanged({
      worktreePath: '/shared',
      events: [{ kind: 'update', absolutePath: '/shared/x.ts' }]
    })
    await act(async () => vi.advanceTimersByTimeAsync(200))
    expect(reloads).toEqual(['local-wt:x.ts'])

    reloads = []
    emitFsChanged({
      worktreePath: '/shared',
      events: [{ kind: 'update', absolutePath: '/shared/x.ts' }],
      connectionId: 'ssh-1'
    })
    await act(async () => vi.advanceTimersByTimeAsync(200))
    expect(reloads).toEqual(['ssh-wt:x.ts'])
  })
})
