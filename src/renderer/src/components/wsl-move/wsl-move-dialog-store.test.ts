import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  WslMovePreview,
  WslMoveProgressEvent,
  WslMoveResult
} from '../../../../shared/wsl-move/wsl-move-driver-types'

const reload = vi.fn()
vi.mock('@/app-shell/startup/lazy-chunk-recovery-reload', () => ({
  requestLazyChunkRecoveryReload: (...args: unknown[]) => reload(...args)
}))

const toastMock = vi.fn()
vi.mock('sonner', () => ({ toast: (...args: unknown[]) => toastMock(...args) }))

const store = await import('./wsl-move-dialog-store')
const { adoptWslMoveProgress } = await import('./wsl-move-run-adoption')
await import('./wsl-move-dialog-close')
const {
  cancelWslMove,
  openWslMoveDialog,
  reviewWslMoveAgain,
  setWslMoveSelection,
  skipWslMoveProjects,
  startWslMove,
  useWslMoveDialogStore
} = store

const READY: WslMovePreview = {
  outcome: 'ready',
  distro: 'Ubuntu',
  repoIds: ['api', 'web'],
  folderWorkspaceIds: ['notes'],
  changed: [],
  heldByHost: [],
  refused: [],
  blockers: []
}

type Api = {
  preview: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  listUnfinished: ReturnType<typeof vi.fn>
  onProgress: ReturnType<typeof vi.fn>
}

let api: Api
let emitProgress: (event: WslMoveProgressEvent) => void
const unsubscribe = vi.fn()

const dialog = () => useWslMoveDialogStore.getState().dialog

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

beforeEach(() => {
  useWslMoveDialogStore.setState({ dialog: { stage: 'closed' }, unfinished: [] })
  emitProgress = () => undefined
  api = {
    preview: vi.fn(async () => READY),
    start: vi.fn(),
    cancel: vi.fn(async () => true),
    listUnfinished: vi.fn(async () => []),
    onProgress: vi.fn((listener: (event: WslMoveProgressEvent) => void) => {
      emitProgress = listener
      return unsubscribe
    })
  }
  vi.stubGlobal('window', { api: { wslMove: api } })
  reload.mockReset()
  unsubscribe.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('preview', () => {
  it('opened from one project, checks only it and previews that selection', async () => {
    await openWslMoveDialog({ distro: 'Ubuntu', only: { kind: 'repo', id: 'web' } })
    expect(api.preview).toHaveBeenLastCalledWith({
      distro: 'Ubuntu',
      repoIds: ['web'],
      folderWorkspaceIds: [],
      sleptPanes: []
    })
    const state = dialog()
    expect(state.stage === 'preview' && state.selected).toEqual([{ kind: 'repo', id: 'web' }])
  })

  it('skips the projects a blocker names', async () => {
    await openWslMoveDialog({ distro: 'Ubuntu' })
    skipWslMoveProjects([{ kind: 'repo', id: 'api' }])
    const state = dialog()
    expect(state.stage === 'preview' && state.selected).toEqual([
      { kind: 'repo', id: 'web' },
      { kind: 'folder', id: 'notes' }
    ])
  })

  it('keeps no checkboxes for a refusal no selection can fix', async () => {
    api.preview.mockResolvedValueOnce({ outcome: 'refused', code: 'wsl_move_host_unavailable' })
    await openWslMoveDialog({
      distro: 'Ubuntu',
      catalogCandidates: () => ({ repoIds: ['api'], folderWorkspaceIds: [] })
    })
    const state = dialog()
    expect(state.stage === 'preview' && state.selected).toEqual([])
    expect(state.stage === 'preview' && state.preview?.outcome).toBe('refused')
  })

  it('checks nothing when the project it was opened from cannot move', async () => {
    await openWslMoveDialog({ distro: 'Ubuntu', only: { kind: 'repo', id: 'held' } })
    const state = dialog()
    expect(state.stage === 'preview' && state.selected).toEqual([])
  })
})

describe('run', () => {
  it('reports a cancel that came too late', async () => {
    await openWslMoveDialog({ distro: 'Ubuntu' })
    const run = deferred<WslMoveResult>()
    api.start.mockReturnValueOnce(run.promise)
    void startWslMove()
    // Refused before the switch: the run was gone or the call failed, not "too late".
    api.cancel.mockResolvedValueOnce(false)
    await cancelWslMove()
    const before = dialog()
    expect(before.stage === 'running' && before.cancel).toBe('idle')
    emitProgress({ distro: 'Ubuntu', step: 'switching' })
    api.cancel.mockResolvedValueOnce(false)
    await cancelWslMove()
    const state = dialog()
    expect(state.stage === 'running' && state.cancel).toBe('too-late')
    expect(api.cancel).toHaveBeenCalledWith('Ubuntu')
  })

  it('follows a run this window did not start, and asks for the reload when it is done', async () => {
    adoptWslMoveProgress({ distro: 'Ubuntu', step: 'copying', migrationId: 'm9' })
    const running = dialog()
    expect(running.stage === 'running' && running.adopted).toBe(true)
    adoptWslMoveProgress({ distro: 'Ubuntu', step: 'done', migrationId: 'm9', phase: 'retained' })
    const state = dialog()
    expect(state.stage === 'result' && state.result.outcome).toBe('moved')
    expect(store.wslMoveDialogLocked(state)).toBe(true)
  })

  it('shows how a followed run ended when it did not commit, instead of its last step', () => {
    // A refused start left the dialog on "Moving… Preparing" until a reload.
    adoptWslMoveProgress({ distro: 'Ubuntu', step: 'preparing' })
    adoptWslMoveProgress({
      distro: 'Ubuntu',
      step: 'preparing',
      result: { outcome: 'refused', code: 'wsl_move_host_unavailable' }
    })
    const state = dialog()
    expect(state.stage === 'result' && state.result).toEqual({
      outcome: 'refused',
      code: 'wsl_move_host_unavailable'
    })
  })

  it('opens nothing for the end of a run it never followed', () => {
    adoptWslMoveProgress({
      distro: 'Ubuntu',
      step: 'preparing',
      result: { outcome: 'refused', code: 'wsl_move_cancelled' }
    })
    expect(dialog().stage).toBe('closed')
  })

  it('leaves its own run to its own listener', async () => {
    await openWslMoveDialog({ distro: 'Ubuntu' })
    api.start.mockReturnValueOnce(deferred<WslMoveResult>().promise)
    void startWslMove()
    adoptWslMoveProgress({ distro: 'Ubuntu', step: 'done', migrationId: 'm1' })
    expect(dialog().stage).toBe('running')
  })

  it('goes back to the same projects after a refusal', async () => {
    await openWslMoveDialog({ distro: 'Ubuntu' })
    setWslMoveSelection([
      { kind: 'repo', id: 'api' },
      { kind: 'folder', id: 'notes' }
    ])
    await vi.waitFor(() => expect(dialog().stage === 'preview').toBe(true))
    api.start.mockResolvedValueOnce({ outcome: 'refused', code: 'wsl_move_scope_changed' })
    await startWslMove()
    await reviewWslMoveAgain()
    const state = dialog()
    expect(state.stage === 'preview' && state.selected).toEqual([
      { kind: 'repo', id: 'api' },
      { kind: 'folder', id: 'notes' }
    ])
  })
})
