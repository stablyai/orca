import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { ProjectMovePauseResponse } from '../../../../shared/project-move-pause'
import { toRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'

const mocks = vi.hoisted(() => {
  const tabsByWorktree: Record<string, { id: string }[]> = {}
  const ptyIdsByTabId: Record<string, string[]> = {}
  const worktreesByRepo: Record<string, { id: string; repoId: string; hostId: string }[]> = {}
  return {
    state: {
      activeWorktreeId: null,
      setActiveWorktree: vi.fn(),
      shutdownWorktreeBrowsers: vi.fn(),
      shutdownWorktreeTerminals: vi.fn<AppState['shutdownWorktreeTerminals']>(),
      tabsByWorktree,
      ptyIdsByTabId,
      worktreesByRepo,
      detectedWorktreesByRepo: {}
    },
    persist: vi.fn(async () => {}),
    payload: vi.fn(() => ({}))
  }
})
vi.mock('@/store', () => ({
  useAppStore: { getState: () => mocks.state, subscribe: () => () => {} }
}))
vi.mock('@/lib/worktree-sleep-intent', () => ({
  clearWorktreeSleepIntent: vi.fn(),
  markWorktreeSleepIntent: vi.fn(),
  withWorktreeSleepTeardown: (_id: string, action: () => Promise<void>) => action()
}))
vi.mock('@/lib/workspace-session', () => ({ buildWorkspaceSessionPayload: mocks.payload }))
vi.mock('@/lib/workspace-session-host-persistence', () => ({
  persistWorkspaceSessionByHost: mocks.persist
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn() } }))
import { createProjectMovePauseFollower } from './project-move-pause-follower'

function fixture() {
  const responses: ProjectMovePauseResponse[] = []
  const follower = createProjectMovePauseFollower((response) => responses.push(response))
  const requestId = 'move-1'
  const prepare = (ids = ['wt']) =>
    follower.request({ requestId, protocol: 1, phase: 'prepare', worktreeIds: ids })
  const persist = (ids = ['wt']) =>
    follower.request({ requestId, protocol: 1, phase: 'persist', successfulWorktreeIds: ids })
  const notice = (phase: 'started' | 'ended', worktreeId = 'wt'): void => {
    follower.follow(
      phase === 'started'
        ? { phase, worktreeId, projectMovePauseId: requestId }
        : {
            phase,
            worktreeId,
            projectMovePauseId: requestId,
            slept: true,
            stoppedPtyIds: ['pty'],
            records: []
          }
    )
  }
  return { follower, responses, prepare, persist, notice }
}

describe('project move renderer completion', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.persist.mockResolvedValue(undefined)
    mocks.state.shutdownWorktreeTerminals.mockImplementation(async (_id, options) => {
      await options?.hostStop
    })
    mocks.state.tabsByWorktree = {}
    mocks.state.ptyIdsByTabId = {}
    mocks.state.worktreesByRepo = {}
    vi.stubGlobal('window', { api: { session: {} } })
  })

  it('awaits renderer teardown and durable session save while retaining browsers', async () => {
    const f = fixture()
    const teardown = Promise.withResolvers<void>()
    const saving = Promise.withResolvers<void>()
    mocks.state.shutdownWorktreeTerminals.mockImplementation(async (_id, options) => {
      await options?.hostStop
      await teardown.promise
    })
    mocks.persist.mockReturnValue(saving.promise)
    await f.prepare()
    const prepared = f.responses[0]
    if (prepared?.phase !== 'prepare') {
      throw new Error('prepare failed')
    }
    f.notice('started')
    f.notice('ended')
    const completion = f.persist()
    expect(mocks.state.shutdownWorktreeBrowsers).not.toHaveBeenCalled()
    expect(mocks.persist).not.toHaveBeenCalled()
    teardown.resolve()
    await vi.waitFor(() => expect(mocks.persist).toHaveBeenCalledOnce())
    expect(f.responses.map((response) => response.phase)).toEqual(['prepare'])
    saving.resolve()
    await completion
    expect(f.responses.map((response) => response.phase)).toEqual(['prepare', 'persist'])
  })

  it('resolves every twin chat host and the terminal owner instead of assuming local', async () => {
    const f = fixture()
    const id = 'repo::/wt'
    mocks.state.worktreesByRepo = {
      repo: [
        { id, repoId: 'repo', hostId: 'local' },
        { id, repoId: 'repo', hostId: 'runtime:env' }
      ]
    }
    mocks.state.tabsByWorktree = { [id]: [{ id: 'tab' }] }
    mocks.state.ptyIdsByTabId = { tab: [toRemoteRuntimePtyId('pty', 'env')] }
    await f.prepare([id])
    expect(f.responses[0]).toEqual({
      requestId: 'move-1',
      protocol: 1,
      phase: 'prepare',
      targets: [
        {
          worktreeId: id,
          terminalHost: { kind: 'environment', environmentId: 'env' },
          chatHosts: [{ kind: 'self' }, { kind: 'environment', environmentId: 'env' }]
        }
      ]
    })
  })

  it('refuses ambiguous twins before starting a sleep', async () => {
    const f = fixture()
    const id = 'repo::/wt'
    mocks.state.worktreesByRepo = {
      repo: [
        { id, repoId: 'repo', hostId: 'local' },
        { id, repoId: 'repo', hostId: 'runtime:env' }
      ]
    }
    await f.prepare([id])
    expect(f.responses[0]?.phase).toBe('error')
    expect(mocks.state.shutdownWorktreeTerminals).not.toHaveBeenCalled()
  })

  it('refuses completion when the follower did not see a supported sleep', async () => {
    const f = fixture()
    await f.prepare()
    await f.persist()
    expect(f.responses.at(-1)).toMatchObject({
      phase: 'error',
      error: 'project_move_pause_missing_completion'
    })
    expect(mocks.persist).not.toHaveBeenCalled()
  })

  it('reports renderer teardown failures instead of persisting and acknowledging success', async () => {
    const f = fixture()
    mocks.state.shutdownWorktreeTerminals.mockRejectedValue(new Error('capture failed'))
    await f.prepare()
    f.notice('started')
    f.notice('ended')
    await f.persist()
    expect(f.responses.at(-1)).toMatchObject({ phase: 'error', error: 'capture failed' })
    expect(mocks.persist).not.toHaveBeenCalled()
  })

  // One workspace of a two-project move failed in main, and its rollback's
  // error failed the whole pause, so the move's retry never ran; a fresh pause re-sleeps it.
  it('persists the slept workspaces of a partly failed pause, and a new pause re-sleeps the rest', async () => {
    const f = fixture()
    mocks.state.shutdownWorktreeTerminals.mockImplementation(async (_id, options) => {
      if ((await options?.hostStop)?.failed) {
        throw new Error('host_terminal_stop_failed')
      }
    })
    await f.prepare(['a', 'b'])
    f.notice('started', 'a')
    f.notice('started', 'b')
    f.notice('ended', 'a')
    f.follower.follow({
      phase: 'ended',
      worktreeId: 'b',
      projectMovePauseId: 'move-1',
      slept: false,
      stoppedPtyIds: [],
      records: null
    })
    await f.persist(['a'])
    expect(f.responses.at(-1)).toMatchObject({ phase: 'persist' })
    await f.follower.request({ requestId: 'move-1', protocol: 1, phase: 'release' })

    const retry = { requestId: 'move-2', protocol: 1 } as const
    await f.follower.request({ ...retry, phase: 'prepare', worktreeIds: ['b'] })
    f.follower.follow({ phase: 'started', worktreeId: 'b', projectMovePauseId: 'move-2' })
    f.follower.follow({
      phase: 'ended',
      worktreeId: 'b',
      projectMovePauseId: 'move-2',
      slept: true,
      stoppedPtyIds: ['pty'],
      records: []
    })
    await f.follower.request({ ...retry, phase: 'persist', successfulWorktreeIds: ['b'] })
    expect(f.responses.at(-1)).toMatchObject({ requestId: 'move-2', phase: 'persist' })
  })

  it('reports durable write failure after teardown', async () => {
    const f = fixture()
    mocks.persist.mockRejectedValue(new Error('disk full'))
    await f.prepare()
    f.notice('started')
    f.notice('ended')
    await f.persist()
    expect(f.responses.at(-1)).toMatchObject({ phase: 'error', error: 'disk full' })
  })

  it('keeps ordinary user sleep behavior and refuses a superseded move pause', async () => {
    const f = fixture()
    await f.prepare()
    f.notice('started')
    f.notice('ended')
    f.follower.follow({ worktreeId: 'wt', phase: 'started' })
    f.follower.follow({
      worktreeId: 'wt',
      phase: 'ended',
      slept: true,
      stoppedPtyIds: [],
      records: []
    })
    await f.persist()
    expect(mocks.state.shutdownWorktreeBrowsers).toHaveBeenCalledWith('wt')
    expect(f.responses.at(-1)).toMatchObject({
      phase: 'error',
      error: 'project_move_pause_sleep_superseded'
    })
  })

  it('reserves overlapping scopes until main releases them', async () => {
    const f = fixture()
    await f.prepare()
    const next = {
      requestId: 'move-2',
      protocol: 1,
      phase: 'prepare',
      worktreeIds: ['wt']
    } as const
    await f.follower.request({ ...next, worktreeIds: [...next.worktreeIds] })
    expect(f.responses.at(-1)).toMatchObject({
      phase: 'error',
      error: 'project_move_pause_scope_busy'
    })
    await f.follower.request({ requestId: 'move-1', protocol: 1, phase: 'release' })
    await f.follower.request({ ...next, worktreeIds: [...next.worktreeIds] })
    expect(f.responses.at(-1)).toMatchObject({ requestId: 'move-2', phase: 'prepare' })
  })

  it('does not acknowledge a write that main released while it was in flight', async () => {
    const f = fixture()
    const saving = Promise.withResolvers<void>()
    mocks.persist.mockReturnValue(saving.promise)
    await f.prepare()
    f.notice('started')
    f.notice('ended')
    const completion = f.persist()
    await vi.waitFor(() => expect(mocks.persist).toHaveBeenCalledOnce())
    await f.follower.request({ requestId: 'move-1', protocol: 1, phase: 'release' })
    saving.resolve()
    await completion
    expect(f.responses.at(-1)).toMatchObject({
      phase: 'error',
      error: 'project_move_pause_released'
    })
  })
})
