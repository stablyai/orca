import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'

const WT = 'repo::/srv/project'
const ENV = 'env-1'
const T1 = toWebTerminalSurfaceTabId('host-tab-1')
const T2 = toWebTerminalSurfaceTabId('host-tab-2')

type MockStore = {
  state: Record<string, unknown>
  call: ReturnType<typeof vi.fn>
  owner: string | null
  listener: ((state: unknown, previous: unknown) => void) | null
}
const mocks = vi.hoisted(() => {
  const store: MockStore = { state: {}, call: vi.fn(), owner: 'env-1', listener: null }
  return store
})
let groups: Record<string, { id: string; activeTabId: string; tabOrder: string[] }[]> = {}
vi.mock('../store', () => ({
  useAppStore: {
    getState: () => mocks.state,
    subscribe: (listener: (state: unknown, previous: unknown) => void) => {
      mocks.listener = listener
      return () => {
        mocks.listener = null
      }
    }
  }
}))
const reassert = vi.hoisted(() => vi.fn())
vi.mock('../lib/cycled-tab-owner-activation', () => ({ activateCycledTabOnOwner: reassert }))
vi.mock('../lib/worktree-runtime-owner', () => ({
  runtimeEnvironmentIdOrLocalUnlessTwin: () => mocks.owner
}))
vi.mock('./web-session-tabs-sync/frame-drawn-server-workspaces', () => ({
  isServerFrameDrawnWorkspace: () => false
}))

import { setRuntimeEnvironmentConnectionGenerationForTests } from '../store/slices/runtime-status-connection-generation'
import {
  forgetVisibleTabPicksForEnvironment,
  reportVisibleTabPickToHost,
  resetReportedVisibleTabPicksForTests,
  VISIBLE_TAB_PICK_SETTLE_MS
} from './web-session-visible-tab-pick-report'

function surface(hostTabId: string, status: 'ready' | 'pending-handle' = 'ready', leafId = 'leaf') {
  return {
    type: 'terminal' as const,
    id: `${hostTabId}::${leafId}`,
    title: hostTabId,
    parentTabId: hostTabId,
    leafId,
    isActive: false,
    ...(status === 'ready'
      ? { status: 'ready' as const, terminal: `term-${hostTabId}` }
      : { status: 'pending-handle' as const, terminal: null })
  }
}

function frame(
  pickedHostTabId: string,
  overrides: Partial<RuntimeMobileSessionTabsResult> = {}
): RuntimeMobileSessionTabsResult {
  return {
    worktree: WT,
    publicationEpoch: 'epoch-1:client-navigation',
    snapshotVersion: 1,
    activeGroupId: 'host-group',
    activeTabId: `${pickedHostTabId}::leaf`,
    activeTabType: 'terminal',
    tabs: [surface('host-tab-1'), surface('host-tab-2')],
    ...overrides
  }
}

function deliver(snapshot: RuntimeMobileSessionTabsResult): void {
  reportVisibleTabPickToHost(ENV, snapshot)
  vi.advanceTimersByTime(VISIBLE_TAB_PICK_SETTLE_MS)
}

describe('reporting the tab the desktop shows to a server that remembers picks per device', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  beforeEach(() => {
    vi.useFakeTimers()
    resetReportedVisibleTabPicksForTests()
    mocks.call.mockReset().mockResolvedValue({ ok: true, result: {} })
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call: mocks.call } } })
    mocks.owner = ENV
    groups = { [WT]: [{ id: 'group', activeTabId: 'u1', tabOrder: ['u1', 'u2'] }] }
    mocks.state = {
      activeWorktreeId: WT,
      activeGroupIdByWorktree: { [WT]: 'group' },
      groupsByWorktree: groups,
      unifiedTabsByWorktree: {
        [WT]: [
          { id: 'u1', contentType: 'terminal', entityId: T1, groupId: 'group' },
          { id: 'u2', contentType: 'terminal', entityId: T2, groupId: 'group' },
          { id: 'u3', contentType: 'browser', entityId: 'browser-ws', groupId: 'group' }
        ]
      },
      terminalLayoutsByTabId: { [T1]: { activeLeafId: 'leaf' } }
    }
  })

  it('moves a stale server pick back to the visible tab, once per connection', () => {
    deliver(frame('host-tab-2'))
    deliver(frame('host-tab-1'))
    // Another window on this device moved it again; only this desktop's own change reports anew.
    deliver(frame('host-tab-2'))

    expect(mocks.call).toHaveBeenCalledTimes(1)
    expect(mocks.call.mock.calls[0]?.[0]).toMatchObject({
      selector: ENV,
      method: 'session.tabs.activate',
      params: {
        tabId: 'host-tab-1',
        leafId: 'leaf',
        notifyClients: false,
        navigation: 'caller',
        intent: 'automatic'
      }
    })
  })

  it('reports again after the desktop moved away and back while the server agreed', () => {
    deliver(frame('host-tab-2'))
    groups[WT]![0]!.activeTabId = 'u2'
    deliver(frame('host-tab-2'))
    groups[WT]![0]!.activeTabId = 'u1'
    deliver(frame('host-tab-2'))
    expect(mocks.call).toHaveBeenCalledTimes(2)
  })

  it('reports when the user opens a workspace whose latest frame went stale', () => {
    mocks.state.activeWorktreeId = 'other'
    deliver(frame('host-tab-2'))
    expect(mocks.call).not.toHaveBeenCalled()

    const previous = mocks.state
    mocks.state = { ...previous, activeWorktreeId: WT }
    mocks.listener?.(mocks.state, previous)
    vi.advanceTimersByTime(VISIBLE_TAB_PICK_SETTLE_MS)
    expect(mocks.call).toHaveBeenCalledTimes(1)
  })

  it('reports nothing for a workspace that is not on screen, or not owned by this server', () => {
    mocks.state.activeWorktreeId = 'other'
    deliver(frame('host-tab-2'))
    mocks.state.activeWorktreeId = WT
    mocks.owner = 'env-2'
    deliver(frame('host-tab-2'))
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it('checks a busy workspace on schedule, against its latest frame', () => {
    reportVisibleTabPickToHost(ENV, frame('host-tab-2'))
    vi.advanceTimersByTime(VISIBLE_TAB_PICK_SETTLE_MS - 1)
    reportVisibleTabPickToHost(ENV, frame('host-tab-2'))
    vi.advanceTimersByTime(1)
    expect(mocks.call).toHaveBeenCalledTimes(1)
  })

  it('checks again when the user moved on before a report finished', async () => {
    let finish: (value: unknown) => void = () => {}
    mocks.call.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    deliver(frame('host-tab-2'))
    expect(mocks.call).toHaveBeenCalledTimes(1)
    groups[WT]![0]!.activeTabId = 'u2'
    deliver(frame('host-tab-2'))
    finish({ ok: true, result: {} })
    await vi.advanceTimersByTimeAsync(0)
    // The host may have taken the late report last; the latest frame now says tab 1.
    deliver(frame('host-tab-1'))
    expect(mocks.call).toHaveBeenCalledTimes(2)
    expect(mocks.call.mock.calls[1]?.[0]).toMatchObject({ params: { tabId: 'host-tab-2' } })
  })

  it('rechecks against the host answer when no later frame arrives', async () => {
    let finish: (value: unknown) => void = () => {}
    mocks.call.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    deliver(frame('host-tab-2'))
    groups[WT]![0]!.activeTabId = 'u2'
    deliver(frame('host-tab-2'))
    // The late report landed last: the host now remembers tab 1, and says so in its answer.
    finish({ ok: true, result: frame('host-tab-1') })
    await vi.advanceTimersByTimeAsync(VISIBLE_TAB_PICK_SETTLE_MS)
    expect(mocks.call).toHaveBeenCalledTimes(2)
    expect(mocks.call.mock.calls[1]?.[0]).toMatchObject({ params: { tabId: 'host-tab-2' } })
  })

  it('sends a browser pick again when a report times out after it was made', async () => {
    reassert.mockReset()
    let fail: (reason: unknown) => void = () => {}
    mocks.call.mockImplementationOnce(() => new Promise((_resolve, reject) => (fail = reject)))
    deliver(frame('host-tab-2'))
    groups[WT]![0]!.activeTabId = 'u3'
    fail(new Error('timeout'))
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() =>
      expect(reassert).toHaveBeenCalledWith(WT, { type: 'browser', id: 'browser-ws', tabId: 'u3' })
    )
  })

  it('does nothing with a report answered after mirror teardown', async () => {
    reassert.mockReset()
    let finish: (value: unknown) => void = () => {}
    mocks.call.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    deliver(frame('host-tab-2'))
    groups[WT]![0]!.activeTabId = 'u3'
    forgetVisibleTabPicksForEnvironment(ENV)
    finish({ ok: true, result: {} })
    await vi.advanceTimersByTimeAsync(VISIBLE_TAB_PICK_SETTLE_MS)
    expect(reassert).not.toHaveBeenCalled()
    expect(mocks.call).toHaveBeenCalledTimes(1)
  })

  it('sends a browser pick again when it was made while a report was in flight', async () => {
    reassert.mockReset()
    let finish: (value: unknown) => void = () => {}
    mocks.call.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    deliver(frame('host-tab-2'))
    groups[WT]![0]!.activeTabId = 'u3'
    finish({ ok: true, result: {} })
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() =>
      expect(reassert).toHaveBeenCalledWith(WT, { type: 'browser', id: 'browser-ws', tabId: 'u3' })
    )
  })

  it('drops a frame whose connection was replaced before the check', () => {
    reportVisibleTabPickToHost(ENV, frame('host-tab-2'))
    setRuntimeEnvironmentConnectionGenerationForTests(ENV, 9)
    vi.advanceTimersByTime(VISIBLE_TAB_PICK_SETTLE_MS)
    expect(mocks.call).not.toHaveBeenCalled()
    setRuntimeEnvironmentConnectionGenerationForTests(ENV, 0)
  })

  it('reports again on a new connection', () => {
    deliver(frame('host-tab-2'))
    setRuntimeEnvironmentConnectionGenerationForTests(ENV, 7)
    deliver(frame('host-tab-2'))
    expect(mocks.call).toHaveBeenCalledTimes(2)
    setRuntimeEnvironmentConnectionGenerationForTests(ENV, 0)
  })

  it('retries after the server answers with an error', async () => {
    mocks.call.mockResolvedValueOnce({ ok: false, error: { code: 'busy' } })
    deliver(frame('host-tab-2'))
    expect(mocks.call).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(0)
    deliver(frame('host-tab-2'))
    expect(mocks.call).toHaveBeenCalledTimes(2)
  })

  it('leaves a click that lands inside the settle window alone', () => {
    reportVisibleTabPickToHost(ENV, frame('host-tab-2'))
    groups[WT]![0]!.activeTabId = 'u2'
    vi.advanceTimersByTime(VISIBLE_TAB_PICK_SETTLE_MS)
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it.each([
    ['the server already remembers it', frame('host-tab-1')],
    ['the server keeps no pick per device', frame('host-tab-2', { publicationEpoch: 'epoch-1' })],
    [
      'the visible tab has no ready terminal',
      frame('host-tab-2', {
        tabs: [surface('host-tab-1', 'pending-handle'), surface('host-tab-2')]
      })
    ],
    [
      'only a sibling of the visible pane is ready',
      frame('host-tab-2', {
        tabs: [
          surface('host-tab-1', 'ready', 'sibling'),
          surface('host-tab-1', 'pending-handle'),
          surface('host-tab-2')
        ]
      })
    ]
  ])('reports nothing when %s', (_case, snapshot) => {
    deliver(snapshot)
    expect(mocks.call).not.toHaveBeenCalled()
  })
})
