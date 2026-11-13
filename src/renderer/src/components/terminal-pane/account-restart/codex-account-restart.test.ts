import {
  admitTerminalNoticeLifetime,
  retireTerminalNoticeLifetime
} from '../provider-notices/terminal-notice-lifetime'
import { toRuntimeExecutionHostId } from '../../../../../shared/execution-host'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/rpc/testing/runtime-compatibility-test-fixture'
import type { PublicKnownRuntimeEnvironment } from '../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { bindStartFreshSpawn } from '../pty-connection/spawn/fresh-spawn-start'
import { settleFreshPaneSpawn } from '../pty-connection/spawn/fresh-pane-spawn-settlement'
import type { PtyTransport } from '../pty-transport/pty-transport-types'
type PtyConnectOptions = Parameters<PtyTransport['connect']>[0]
import { getPaneSpawnDeferral } from '../session-restore/spawn-deferral/pane-spawn-deferral-registry'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { selectCodexStaleSessionCount } from '@/components/status-bar/codex-restart-status-summary'
import { codexAccountRestartToken } from '@/store/terminals/codex-account-restart-continuation'
import {
  prepareCodexAccountRestart,
  failCodexAccountRestart,
  retryCodexAccountRestarts
} from './codex-account-restart-execution'
import {
  sweepUnclaimedCodexPaneRestarts,
  resetDetachedCodexPaneRestartClaimsForTests
} from './detached/codex-detached-pane-restart'
import { STALLED_DETACHED_RESTART_MS } from './detached/detached-pane-restart-slots'
import { formatAccountRestartFailure } from '../../../../../shared/terminal/pty/lifecycle/account-restart-contract'

const { buildStartup } = vi.hoisted(() => ({
  buildStartup: vi.fn(() => ({
    command: 'codex resume conversation-1',
    startupCommandDelivery: 'shell-ready',
    launchAgent: 'codex',
    resumeProviderSession: { id: 'conversation-1' }
  }))
}))
vi.mock('@/lib/agent-session/accounts/agent-account-restart-startup', () => ({
  captureAgentAccountRestartResumeInput: () => ({ providerSession: { id: 'conversation-1' } }),
  buildPaneAccountRestartStartup: buildStartup
}))

const leaf = '00000000-0000-4000-8000-000000000001'
const sibling = '00000000-0000-4000-8000-000000000002'
const key = `tab:${leaf}`
const spawn = vi.fn()
const call = vi.fn()
const notice = { previousAccountLabel: 'old', nextAccountLabel: 'new' }
function seed() {
  useAppStore.setState({
    tabsByWorktree: {
      wt: [
        {
          id: 'tab',
          worktreeId: 'wt',
          createdAt: 1,
          ptyId: 'old',
          title: 'Codex',
          customTitle: null,
          color: null,
          sortOrder: 0
        }
      ]
    },
    ptyIdsByTabId: { tab: ['old', 'sibling'] },
    terminalLayoutsByTabId: {
      tab: {
        root: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', leafId: leaf },
          second: { type: 'leaf', leafId: sibling }
        },
        activeLeafId: leaf,
        expandedLeafId: null,
        ptyIdsByLeafId: { [leaf]: 'old', [sibling]: 'sibling' }
      }
    },
    codexRestartNoticeByPtyId: { old: notice },
    paneAccountRestarts: {}
  })
}
function accepted() {
  useAppStore.getState().queuePaneAccountRestarts(['old'], 'codex')
  const request = useAppStore.getState().claimCodexAccountRestart(key)
  if (!request) {
    throw new Error('request not accepted')
  }
  return request
}
function receipt(
  request: ReturnType<typeof accepted>,
  stop: 'not-started' | 'confirmed-retired' | 'unknown',
  kind: 'original' | 'empty'
) {
  return new Error(
    formatAccountRestartFailure('launch refused', {
      v: 1,
      requestId: request.requestId,
      attemptId: request.attemptId,
      stop,
      outcome: 'terminal',
      current: {
        kind,
        bindingGeneration: kind === 'empty' ? 1 : 0,
        ...(kind === 'original' ? { incarnationId: 'inc-old' } : {})
      }
    })
  )
}
function snapshot(
  owner: { ptyId: string; incarnationId: string } | null,
  generation = 0,
  tabCreatedAt = 1
) {
  return {
    ok: true,
    id: 'resolve',
    result: {
      terminal: {
        handle: 'handle-old',
        accountRestart: { hostEpoch: 'host', tabCreatedAt, bindingGeneration: generation, owner }
      }
    }
  }
}

function mountedSpawnSession(
  request: ReturnType<typeof accepted>,
  scrollback: Map<string, string>,
  connect: (options: PtyConnectOptions) => Promise<unknown>,
  incarnationId?: string
) {
  const noop = () => {}
  return {
    deps: {
      tabId: 'tab',
      worktreeId: 'wt',
      accountRestartToken: codexAccountRestartToken(request),
      accountRestart: request.condition,
      isVisibleRef: { current: false },
      invalidateRetainedInlineScrollback: (leafId: string) => scrollback.delete(leafId)
    },
    pane: { id: 1, leafId: leaf },
    paneStartup: { command: 'codex resume conversation-1' },
    remotePtyIncarnationId: incarnationId,
    disposed: false,
    tabGeneration: 0,
    transportStreamGeneration: 1,
    authoritativeReattachGeneration: 0,
    pendingSpawnKey: key,
    cacheKey: key,
    userRestart: false,
    runtimeEnvironmentId: null,
    transport: { connect, getPtyId: (): string | null => null },
    clearPaneMode2031State: noop,
    clearHiddenOutputRestoreState: noop,
    resetFreshSpawnFollowOutput: noop,
    groundInputModesForNewProcess: noop,
    prepareFreshShellViewportForSpawn: noop,
    shouldDeclareHiddenAtSpawn: () => true,
    captureTransportOutputCallbacks: (onError: (message: string) => void) => ({
      generation: 1,
      callbacks: { onError }
    }),
    reportError: noop,
    finishReattachLiveDataDeferral: noop,
    noteBoundProcessIncarnation: noop,
    settlePaneAttachAttempt: noop,
    startFreshSpawn: (_startup?: { command: string }): Promise<string | null> =>
      Promise.resolve(null)
  }
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  resetDetachedCodexPaneRestartClaimsForTests()
  buildStartup.mockClear()
  call.mockReset().mockResolvedValue(snapshot({ ptyId: 'old', incarnationId: 'inc-old' }))
  spawn.mockReset().mockResolvedValue({ id: 'replacement' })
  vi.stubGlobal('window', { api: { pty: { spawn, kill: vi.fn() }, runtime: { call } } })
  window.api.pty.declarePendingPaneSerializer = vi.fn().mockResolvedValue(1)
  window.api.pty.clearPendingPaneSerializer = vi.fn().mockResolvedValue(undefined)
  seed()
})
afterEach(() => {
  resetDetachedCodexPaneRestartClaimsForTests()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('Codex account continuation', () => {
  it('hides accepted work, retains the captured conversation through failure, and retries a proven empty leaf', async () => {
    const request = accepted(),
      token = codexAccountRestartToken(request)
    expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(0)
    await prepareCodexAccountRestart(request)
    useAppStore.setState({ agentStatusByPaneKey: {} })
    failCodexAccountRestart(token, receipt(request, 'confirmed-retired', 'empty'))
    expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(1)
    expect(useAppStore.getState().ptyIdsByTabId.tab).toEqual(['sibling'])
    const failure = useAppStore.getState().paneAccountRestarts[key]
    if (typeof failure !== 'object') {
      throw new Error('failure not retained')
    }
    await retryCodexAccountRestarts([failure])
    call.mockResolvedValue(snapshot(null, 1))
    await sweepUnclaimedCodexPaneRestarts()
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'codex resume conversation-1',
        spawnIntent: 'user-resume',
        resumeProviderSession: { id: 'conversation-1' },
        accountRestart: expect.objectContaining({
          expected: { kind: 'empty', bindingGeneration: 1 }
        })
      })
    )
    expect(useAppStore.getState().terminalLayoutsByTabId.tab.ptyIdsByLeafId).toEqual({
      [leaf]: 'replacement',
      [sibling]: 'sibling'
    })
    expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(0)
  })

  it('reports pre-stop failure while keeping the exact old endpoint guarded', async () => {
    const request = accepted()
    await prepareCodexAccountRestart(request)
    failCodexAccountRestart(
      codexAccountRestartToken(request),
      receipt(request, 'not-started', 'original')
    )
    expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(1)
    expect(useAppStore.getState().ptyIdsByTabId.tab).toEqual(['old', 'sibling'])
  })

  it('discards an obsolete catch after an unrelated successor wins, including an idle shell', async () => {
    const request = accepted()
    await prepareCodexAccountRestart(request)
    useAppStore.getState().replaceTerminalLayoutPanePtyId('tab', leaf, 'idle-shell-with-input')
    failCodexAccountRestart(
      codexAccountRestartToken(request),
      receipt(request, 'confirmed-retired', 'empty')
    )
    expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(0)
    expect(useAppStore.getState().terminalLayoutsByTabId.tab.ptyIdsByLeafId?.[leaf]).toBe(
      'idle-shell-with-input'
    )
    expect(spawn).not.toHaveBeenCalled()
  })

  it('ignores a prior attempt after Retry and a pane closed during reconciliation', async () => {
    const request = accepted()
    await prepareCodexAccountRestart(request)
    failCodexAccountRestart(
      codexAccountRestartToken(request),
      receipt(request, 'not-started', 'original')
    )
    useAppStore.getState().retryCodexAccountRestart(codexAccountRestartToken(request))
    failCodexAccountRestart(
      codexAccountRestartToken(request),
      receipt(request, 'confirmed-retired', 'empty')
    )
    expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(0)
    const latest = useAppStore.getState().claimCodexAccountRestart(key)
    if (!latest) {
      throw new Error('retry not accepted')
    }
    const read = Promise.withResolvers<ReturnType<typeof snapshot>>()
    call.mockReturnValue(read.promise)
    const preparing = prepareCodexAccountRestart(latest)
    useAppStore.getState().setTabLayout('tab', {
      root: { type: 'leaf', leafId: sibling },
      activeLeafId: sibling,
      expandedLeafId: null,
      ptyIdsByLeafId: { [sibling]: 'sibling' }
    })
    read.resolve(snapshot({ ptyId: 'old', incarnationId: 'inc-old' }))
    await expect(preparing).resolves.toBeNull()
    expect(useAppStore.getState().paneAccountRestarts).toEqual({})
    expect(spawn).not.toHaveBeenCalled()
  })

  it('keeps a stalled attempt unresolved, reconciles without duplicate launch, then adopts its late result', async () => {
    vi.useFakeTimers()
    const pending = Promise.withResolvers<{ id: string }>()
    spawn.mockReturnValue(pending.promise)
    useAppStore.getState().queuePaneAccountRestarts(['old'], 'codex')
    const running = sweepUnclaimedCodexPaneRestarts()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(STALLED_DETACHED_RESTART_MS)
    expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(1)
    const unresolved = useAppStore.getState().paneAccountRestarts[key]
    if (typeof unresolved !== 'object') {
      throw new Error('attempt not retained')
    }
    await retryCodexAccountRestarts([unresolved])
    await sweepUnclaimedCodexPaneRestarts()
    expect(spawn).toHaveBeenCalledTimes(1)
    pending.resolve({ id: 'late-replacement' })
    await running
    expect(useAppStore.getState().terminalLayoutsByTabId.tab.ptyIdsByLeafId?.[leaf]).toBe(
      'late-replacement'
    )
    expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(0)
  })
  it('retains a genuine deferred launch, then starts its captured command when resumed', async () => {
    spawn.mockRejectedValueOnce(
      new Error(
        formatAccountRestartFailure('terminal_spawn_deferred:paused', {
          v: 1,
          requestId: 'unused',
          attemptId: 'unused',
          stop: 'not-started',
          outcome: 'terminal'
        })
      )
    )
    useAppStore.getState().queuePaneAccountRestarts(['old'], 'codex')
    const queued = useAppStore.getState().paneAccountRestarts[key]
    if (typeof queued !== 'object') {
      throw new Error('missing request')
    }
    spawn.mockReset().mockRejectedValueOnce(
      new Error(
        formatAccountRestartFailure('terminal_spawn_deferred:paused', {
          v: 1,
          requestId: queued.requestId,
          attemptId: queued.attemptId,
          stop: 'not-started',
          outcome: 'terminal',
          current: { kind: 'original', bindingGeneration: 0, incarnationId: 'inc-old' }
        })
      )
    )
    await sweepUnclaimedCodexPaneRestarts()
    expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(0)
    expect(getPaneSpawnDeferral(key)?.reason).toBe('paused')
    spawn.mockResolvedValue({ id: 'resumed' })
    getPaneSpawnDeferral(key)?.resume()
    await sweepUnclaimedCodexPaneRestarts()
    expect(useAppStore.getState().terminalLayoutsByTabId.tab.ptyIdsByLeafId?.[leaf]).toBe('resumed')
    expect(getPaneSpawnDeferral(key)).toBeUndefined()
  })
  it.each(['callback', 'rejection'] as const)(
    'settles the mounted %s failure after userRestart was cleared without clearing scrollback',
    async (mode) => {
      const request = accepted()
      await prepareCodexAccountRestart(request)
      const failure = receipt(request, 'confirmed-retired', 'empty')
      const scrollback = new Map([
        [leaf, 'old transcript'],
        [sibling, 'sibling transcript']
      ])
      const session = mountedSpawnSession(request, scrollback, async (options) => {
        if (mode === 'callback') {
          options.callbacks?.onError?.(failure.message)
          return undefined
        }
        throw failure
      })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements every member used by these failed-spawn paths.
      bindStartFreshSpawn(session as never)
      await session.startFreshSpawn({ command: 'codex resume conversation-1' })
      expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(1)
      expect(useAppStore.getState().terminalLayoutsByTabId.tab.ptyIdsByLeafId).toEqual({
        [sibling]: 'sibling'
      })
      expect([...scrollback]).toEqual([
        [leaf, 'old transcript'],
        [sibling, 'sibling transcript']
      ])
    }
  )

  it('clears only the completed mounted replacement scrollback and ignores an obsolete result', async () => {
    const request = accepted()
    await prepareCodexAccountRestart(request)
    const token = codexAccountRestartToken(request)
    const scrollback = new Map([
      [leaf, 'old transcript'],
      [sibling, 'sibling transcript']
    ])
    const session = mountedSpawnSession(request, scrollback, async () => undefined)
    session.transport.getPtyId = () => 'replacement'
    useAppStore.getState().updateCodexAccountRestart(token, { resultPtyId: 'replacement' })
    useAppStore.getState().updateTabPtyId('tab', 'replacement', 'old')
    useAppStore.getState().replaceTerminalLayoutPanePtyId('tab', leaf, 'replacement')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements the account settlement and transport members exercised here.
    settleFreshPaneSpawn(session as never, {
      spawnedPtyId: 'replacement',
      accountError: null,
      accountDeferred: false,
      ownerRefused: false,
      generation: 1,
      startupOverride: null,
      options: {}
    })
    expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(0)
    expect([...scrollback]).toEqual([[sibling, 'sibling transcript']])
    scrollback.set(leaf, 'successor transcript')
    useAppStore.getState().replaceTerminalLayoutPanePtyId('tab', leaf, 'successor')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements the account settlement and transport members exercised here.
    settleFreshPaneSpawn(session as never, {
      spawnedPtyId: 'replacement',
      accountError: null,
      accountDeferred: false,
      ownerRefused: false,
      generation: 1,
      startupOverride: null,
      options: {}
    })
    expect(scrollback.get(leaf)).toBe('successor transcript')
    expect(useAppStore.getState().terminalLayoutsByTabId.tab.ptyIdsByLeafId?.[leaf]).toBe(
      'successor'
    )
  })
  it.each(['main frame', 'runtime mirror'] as const)(
    'retires a failed split leaf inside the accepted %s commit and ignores its late catch',
    async (source) => {
      const request = accepted()
      await prepareCodexAccountRestart(request)
      const token = codexAccountRestartToken(request)
      failCodexAccountRestart(token, receipt(request, 'not-started', 'original'))
      const patch = {
        terminalLayoutsByTabId: {
          tab: {
            root: { type: 'leaf' as const, leafId: sibling },
            activeLeafId: sibling,
            expandedLeafId: null,
            ptyIdsByLeafId: { [sibling]: 'sibling' }
          }
        }
      }
      if (source === 'main frame') {
        const { showFramePatch } = await import('@/store/slices/tabs/moved-tab-selection')
        showFramePatch(useAppStore, patch)
      } else {
        const { applyWebSessionTabsStorePatch } =
          await import('@/runtime/web-session-tabs-sync/store-patch')
        applyWebSessionTabsStorePatch(() => patch, { frames: [] })
      }
      failCodexAccountRestart(token, receipt(request, 'confirmed-retired', 'empty'))
      expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(0)
      expect(useAppStore.getState().terminalLayoutsByTabId.tab.ptyIdsByLeafId).toEqual({
        [sibling]: 'sibling'
      })
      expect(spawn).not.toHaveBeenCalled()
    }
  )

  it('reconciles a receipt from another attempt as unknown and never dispatches a duplicate', async () => {
    const request = accepted()
    await prepareCodexAccountRestart(request)
    failCodexAccountRestart(
      codexAccountRestartToken(request),
      new Error(
        formatAccountRestartFailure('launch refused', {
          v: 1,
          requestId: 'another-request',
          attemptId: 'another-attempt',
          stop: 'confirmed-retired',
          outcome: 'terminal',
          current: { kind: 'empty', bindingGeneration: 1 }
        })
      )
    )
    const current = useAppStore.getState().paneAccountRestarts[key]
    if (typeof current !== 'object') {
      throw new Error('unknown attempt was lost')
    }
    await retryCodexAccountRestarts([current])
    await sweepUnclaimedCodexPaneRestarts()
    expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(1)
    expect(spawn).not.toHaveBeenCalled()
    expect(useAppStore.getState().terminalLayoutsByTabId.tab.ptyIdsByLeafId?.[leaf]).toBe('old')
  })
  it.each(['pairing', 'runtime'] as const)(
    'retires the captured request atomically when its %s identity changes',
    async (change) => {
      const environment: PublicKnownRuntimeEnvironment = {
        id: 'env-account',
        name: 'Test host',
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: null,
        runtimeId: null,
        pairingRevision: 1,
        hostKeyFingerprint: 'same-host',
        endpoints: [
          { id: 'ws-account', kind: 'websocket', label: 'WebSocket', endpoint: 'ws://test-host' }
        ],
        preferredEndpointId: 'ws-account'
      }
      useAppStore.getState().setRuntimeEnvironments([environment])
      const hostId = toRuntimeExecutionHostId('env-account')
      useAppStore.setState({
        repos: [{ ...TEST_REPO, id: 'remote-repo', executionHostId: hostId }],
        worktreesByRepo: {
          'remote-repo': [
            makeWorktree({
              id: 'wt',
              repoId: 'remote-repo',
              hostId,
              runtimeOwnerEnvironmentId: 'env-account'
            })
          ]
        }
      })
      useAppStore.getState().setRuntimeEnvironmentStatus('env-account', {
        checkedAt: 1,
        status: createCompatibleRuntimeStatusResponse('runtime-before').result
      })
      const request = accepted()
      useAppStore
        .getState()
        .updateCodexAccountRestart(codexAccountRestartToken(request), { phase: 'failed' })
      expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(1)
      if (change === 'pairing') {
        useAppStore.getState().setRuntimeEnvironments([{ ...environment, pairingRevision: 2 }])
      } else {
        useAppStore.getState().setRuntimeEnvironmentStatus('env-account', {
          checkedAt: 2,
          status: createCompatibleRuntimeStatusResponse('runtime-after').result
        })
      }
      expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(0)
      if (change === 'pairing') {
        useAppStore.getState().setRuntimeEnvironments([environment])
      } else {
        useAppStore.getState().setRuntimeEnvironmentStatus('env-account', {
          checkedAt: 3,
          status: createCompatibleRuntimeStatusResponse('runtime-before').result
        })
      }
      await retryCodexAccountRestarts([request])
      expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(0)
      expect(useAppStore.getState().terminalLayoutsByTabId.tab.ptyIdsByLeafId?.[leaf]).toBe('old')
      expect(spawn).not.toHaveBeenCalled()
    }
  )
  it('keeps a late terminal failure authoritative over an older Retry read and then restarts its empty leaf', async () => {
    vi.useFakeTimers()
    const pending = Promise.withResolvers<{ id: string }>()
    spawn.mockReturnValueOnce(pending.promise)
    useAppStore.getState().queuePaneAccountRestarts(['old'], 'codex')
    const running = sweepUnclaimedCodexPaneRestarts()
    await vi.advanceTimersByTimeAsync(STALLED_DETACHED_RESTART_MS)
    const request = useAppStore.getState().paneAccountRestarts[key]
    if (typeof request !== 'object') {
      throw new Error('stalled attempt was lost')
    }
    call.mockRejectedValueOnce(new Error('rpc_timeout'))
    await retryCodexAccountRestarts([request])
    const read = Promise.withResolvers<ReturnType<typeof snapshot>>()
    call.mockReturnValueOnce(read.promise)
    const reconciling = retryCodexAccountRestarts([request])
    pending.reject(receipt(request, 'confirmed-retired', 'empty'))
    await running
    read.resolve(snapshot({ ptyId: 'old', incarnationId: 'inc-old' }))
    await reconciling
    const failed = useAppStore.getState().paneAccountRestarts[key]
    if (typeof failed !== 'object') {
      throw new Error('terminal failure was discarded by an obsolete read')
    }
    await retryCodexAccountRestarts([failed])
    call.mockResolvedValue(snapshot(null, 1))
    spawn.mockResolvedValue({ id: 'after-late-failure' })
    await sweepUnclaimedCodexPaneRestarts()
    expect(useAppStore.getState().terminalLayoutsByTabId.tab.ptyIdsByLeafId?.[leaf]).toBe(
      'after-late-failure'
    )
    expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(0)
    expect(spawn).toHaveBeenCalledTimes(2)
  })
  it('reopens a legacy Codex queue prompt without entering the unguarded restart route', async () => {
    useAppStore.setState({
      paneAccountRestarts: { old: 'codex' },
      codexRestartNoticeByPtyId: { old: { ...notice, restartRequested: true } }
    })
    await sweepUnclaimedCodexPaneRestarts()
    expect(spawn).not.toHaveBeenCalled()
    expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(1)
  })
  it.each(['mounted', 'detached'] as const)(
    'preserves a known same-ID successor scrollback after a late %s result',
    async (mode) => {
      vi.useFakeTimers()
      const pending = Promise.withResolvers<{ id: string; incarnationId: string }>()
      let request: ReturnType<typeof accepted>
      let running: Promise<void> | undefined
      if (mode === 'mounted') {
        request = accepted()
        await prepareCodexAccountRestart(request)
      } else {
        spawn.mockReturnValueOnce(pending.promise)
        useAppStore.getState().queuePaneAccountRestarts(['old'], 'codex')
        running = sweepUnclaimedCodexPaneRestarts()
        await vi.advanceTimersByTimeAsync(0)
        const current = useAppStore.getState().paneAccountRestarts[key]
        if (typeof current !== 'object') {
          throw new Error('attempt was not dispatched')
        }
        request = current
      }
      const lifetime = admitTerminalNoticeLifetime('old', {
        incarnationId: 'inc-successor',
        fresh: true
      })
      try {
        const layout = useAppStore.getState().terminalLayoutsByTabId.tab
        useAppStore
          .getState()
          .setTabLayout('tab', { ...layout, buffersByLeafId: { [leaf]: 'successor transcript' } })
        if (mode === 'mounted') {
          const scrollback = new Map([[leaf, 'successor transcript']])
          const session = mountedSpawnSession(
            request,
            scrollback,
            async () => undefined,
            'inc-own-replacement'
          )
          session.transport.getPtyId = () => 'old'
          useAppStore
            .getState()
            .updateCodexAccountRestart(codexAccountRestartToken(request), { resultPtyId: 'old' })
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies the settlement and captured incarnation members read here.
          settleFreshPaneSpawn(session as never, {
            spawnedPtyId: 'old',
            accountError: null,
            accountDeferred: false,
            ownerRefused: false,
            generation: 1,
            startupOverride: null,
            options: {}
          })
          expect(scrollback.get(leaf)).toBe('successor transcript')
        } else {
          pending.resolve({ id: 'old', incarnationId: 'inc-own-replacement' })
          await running
        }
        expect(useAppStore.getState().terminalLayoutsByTabId.tab.buffersByLeafId?.[leaf]).toBe(
          'successor transcript'
        )
        expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(0)
      } finally {
        retireTerminalNoticeLifetime(lifetime)
      }
    }
  )

  it('reopens the live moved endpoint without carrying the old request into its new pane', async () => {
    const request = accepted()
    await prepareCodexAccountRestart(request)
    failCodexAccountRestart(
      codexAccountRestartToken(request),
      receipt(request, 'not-started', 'original')
    )
    const { showFramePatch } = await import('@/store/slices/tabs/moved-tab-selection')
    const state = useAppStore.getState(),
      tab = state.tabsByWorktree.wt[0]
    showFramePatch(useAppStore, {
      tabsByWorktree: {
        wt: [
          { ...tab, ptyId: 'sibling' },
          { ...tab, id: 'tab-moved', createdAt: 2 }
        ]
      },
      ptyIdsByTabId: { tab: ['sibling'], 'tab-moved': ['old'] },
      terminalLayoutsByTabId: {
        tab: {
          root: { type: 'leaf', leafId: sibling },
          activeLeafId: sibling,
          expandedLeafId: null,
          ptyIdsByLeafId: { [sibling]: 'sibling' }
        },
        'tab-moved': {
          root: { type: 'leaf', leafId: leaf },
          activeLeafId: leaf,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leaf]: 'old' }
        }
      }
    })
    expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(1)
    useAppStore.getState().queuePaneAccountRestarts(['old'], 'codex')
    call.mockResolvedValue(snapshot({ ptyId: 'old', incarnationId: 'inc-old' }, 0, 2))
    await sweepUnclaimedCodexPaneRestarts()
    expect(useAppStore.getState().terminalLayoutsByTabId['tab-moved'].ptyIdsByLeafId?.[leaf]).toBe(
      'replacement'
    )
    expect(useAppStore.getState().terminalLayoutsByTabId.tab.ptyIdsByLeafId?.[sibling]).toBe(
      'sibling'
    )
    expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(0)
  })
})
