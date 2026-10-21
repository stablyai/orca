// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

type TestWatchTarget = {
  worktreeId: string
  worktreePath: string
  connectionId: string | undefined
  runtimeEnvironmentId: string | null
}

const harness = vi.hoisted(() => {
  const targets: TestWatchTarget[] = []
  const unwatched: TestWatchTarget[] = []
  const runtimeReady: { current: (() => void) | undefined } = { current: undefined }
  return {
    runtimeReady,
    keyOf: (target: TestWatchTarget): string =>
      `${target.worktreeId}::${target.runtimeEnvironmentId ?? 'client'}`,
    targets,
    unwatched,
    // Why: the hook resyncs through the event handler's overflow path; this records those calls.
    catchUp: vi.fn(),
    runtimeUnsubscribe: vi.fn()
  }
})

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector({}), {
    getState: () => ({ openFiles: [], setPendingDiskBaselineVerification: vi.fn() })
  })
}))
vi.mock('./editor-external-watch-targets', () => ({
  selectEditorExternalWatchTargets: () => ({
    targets: [...harness.targets],
    targetsKey: harness.targets.map(harness.keyOf).join('|'),
    unwatchedTargetKeys: new Set(harness.unwatched.map(harness.keyOf)),
    unwatchedTargetsKey: harness.unwatched.map(harness.keyOf).join('|')
  }),
  getEditorExternalWatchTargetKey: harness.keyOf,
  getOpenFileRuntimeOwner: () => null
}))
vi.mock('./editor-runtime-file-watch', () => ({
  subscribeEditorRuntimeFileWatch: (
    _target: unknown,
    _onPayload: unknown,
    _onError: unknown,
    onFirstReady?: () => void
  ) => {
    harness.runtimeReady.current = onFirstReady
    return harness.runtimeUnsubscribe
  }
}))
vi.mock('./editor-external-watch-event-reconciliation', () => ({
  buildEditorExternalWatchEventHandler: () => ({
    handleFsChanged: harness.catchUp,
    dispose: vi.fn()
  })
}))
vi.mock('./editor-external-watch-disk-verification', () => ({
  verifyLatchedEditorMoveDestinations: vi.fn()
}))

import { useEditorExternalWatch } from './useEditorExternalWatch'

function resyncOf(target: TestWatchTarget): [unknown, string | null, TestWatchTarget] {
  return [
    {
      worktreePath: target.worktreePath,
      events: [{ kind: 'overflow', absolutePath: target.worktreePath }],
      resync: true,
      connectionId: target.connectionId
    },
    target.runtimeEnvironmentId,
    target
  ]
}

function WatchProbe(): null {
  useEditorExternalWatch()
  return null
}

const active: TestWatchTarget = {
  worktreeId: 'active',
  worktreePath: '/active',
  connectionId: undefined,
  runtimeEnvironmentId: null
}
const background: TestWatchTarget = {
  worktreeId: 'background',
  worktreePath: '/background',
  connectionId: undefined,
  runtimeEnvironmentId: null
}
const runtimeBackground: TestWatchTarget = {
  worktreeId: 'runtime-background',
  worktreePath: '/runtime',
  connectionId: undefined,
  runtimeEnvironmentId: 'env-1'
}

describe('useEditorExternalWatch with background trim', () => {
  let container: HTMLDivElement
  let root: Root
  let previousApi: unknown
  let watchWorktree: ReturnType<typeof vi.fn>
  let unwatchWorktree: ReturnType<typeof vi.fn>
  let resolveWatch: () => void

  async function render(targets: TestWatchTarget[], unwatched: TestWatchTarget[]): Promise<void> {
    harness.targets.splice(0, harness.targets.length, ...targets)
    harness.unwatched.splice(0, harness.unwatched.length, ...unwatched)
    await act(async () => root.render(createElement(WatchProbe)))
  }

  beforeEach(() => {
    vi.clearAllMocks()
    watchWorktree = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveWatch = resolve
        })
    )
    unwatchWorktree = vi.fn().mockResolvedValue(undefined)
    previousApi = (window as unknown as { api?: unknown }).api
    ;(window as unknown as { api: unknown }).api = {
      fs: { watchWorktree, unwatchWorktree, onFsChanged: vi.fn(() => vi.fn()) }
    }
    container = document.body.appendChild(document.createElement('div'))
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    ;(window as unknown as { api?: unknown }).api = previousApi
  })

  it('refreshes a dropped workspace once its watch request settles', async () => {
    await render([active], [background])
    await render([active, background], [])
    expect(watchWorktree).toHaveBeenLastCalledWith({
      worktreePath: '/background',
      connectionId: undefined
    })
    expect(harness.catchUp).not.toHaveBeenCalled()

    await act(async () => resolveWatch())
    expect(harness.catchUp).toHaveBeenCalledWith(...resyncOf(background))
    expect(harness.catchUp).toHaveBeenCalledTimes(1)
  })

  it('refreshes a dropped runtime workspace once its host reports the watch ready', async () => {
    await render([active], [runtimeBackground])
    await render([active, runtimeBackground], [])
    expect(harness.catchUp).not.toHaveBeenCalled()

    await act(async () => harness.runtimeReady.current?.())
    expect(harness.catchUp).toHaveBeenCalledWith(...resyncOf(runtimeBackground))
  })

  it('releases and re-requests an SSH workspace watch through its connection', async () => {
    const ssh: TestWatchTarget = {
      worktreeId: 'ssh',
      worktreePath: '/home/me/repo',
      connectionId: 'conn-1',
      runtimeEnvironmentId: null
    }
    await render([active, ssh], [])
    await render([active], [ssh])
    expect(unwatchWorktree).toHaveBeenCalledWith({
      worktreePath: '/home/me/repo',
      connectionId: 'conn-1'
    })

    await render([active, ssh], [])
    expect(watchWorktree).toHaveBeenLastCalledWith({
      worktreePath: '/home/me/repo',
      connectionId: 'conn-1'
    })
    await act(async () => resolveWatch())
    expect(harness.catchUp).toHaveBeenCalledWith(...resyncOf(ssh))
  })

  it('retries a failed directory watch when another workspace on it needs it', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      watchWorktree
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('provider gone'))
      await render([active, background], [])
      expect(watchWorktree).toHaveBeenCalledTimes(2)

      await render([active, background, { ...background, worktreeId: 'sibling' }], [])
      expect(watchWorktree).toHaveBeenCalledTimes(3)
      expect(watchWorktree).toHaveBeenLastCalledWith({
        worktreePath: '/background',
        connectionId: undefined
      })
    } finally {
      warning.mockRestore()
    }
  })

  it('does not refresh a workspace whose tabs were just opened', async () => {
    await render([active], [])
    await render([active, background], [])
    await act(async () => resolveWatch())

    expect(harness.catchUp).not.toHaveBeenCalled()
  })

  it('keeps a directory watched while another workspace on it still needs it', async () => {
    const sibling = { ...background, worktreeId: 'sibling' }
    await render([active, background, sibling], [])
    expect(watchWorktree).toHaveBeenCalledTimes(2)

    await render([active, sibling], [background])
    expect(unwatchWorktree).not.toHaveBeenCalled()

    await render([active], [background, sibling])
    expect(unwatchWorktree).toHaveBeenCalledTimes(1)
    expect(unwatchWorktree).toHaveBeenCalledWith({
      worktreePath: '/background',
      connectionId: undefined
    })
  })

  it('refreshes a re-watched workspace whose directory another workspace already watches', async () => {
    const sibling = { ...background, worktreeId: 'sibling' }
    await render([active, sibling], [background])
    await render([active, sibling, background], [])

    expect(watchWorktree).toHaveBeenCalledTimes(2)
    await act(async () => resolveWatch())
    expect(harness.catchUp).toHaveBeenCalledWith(...resyncOf(background))
  })

  it('only releases when a background workspace drops out', async () => {
    await render([active, background], [])
    watchWorktree.mockClear()

    await render([active], [background])
    expect(unwatchWorktree).toHaveBeenCalledTimes(1)
    expect(unwatchWorktree).toHaveBeenCalledWith({
      worktreePath: '/background',
      connectionId: undefined
    })
    expect(watchWorktree).not.toHaveBeenCalled()
    expect(harness.catchUp).not.toHaveBeenCalled()
  })

  it('leaves no watch behind after all tabs close or the app unmounts', async () => {
    await render([active, background, runtimeBackground], [])
    await render([], [])
    expect(unwatchWorktree).toHaveBeenCalledTimes(2)
    expect(harness.runtimeUnsubscribe).toHaveBeenCalledTimes(1)

    await render([active], [background])
    await act(async () => root.unmount())
    expect(unwatchWorktree).toHaveBeenCalledTimes(3)
    expect(unwatchWorktree).toHaveBeenLastCalledWith({
      worktreePath: '/active',
      connectionId: undefined
    })
    root = createRoot(container)
  })
})
