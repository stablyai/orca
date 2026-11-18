import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
import { codexAccountRestartToken } from '@/store/terminals/codex-account-restart-continuation'
import { selectCodexStaleSessionCount } from '@/components/status-bar/accounts/codex-restart-status-summary'
import { installSpawnDeferredSleep } from '../pty-connection/spawn/spawn-deferred-sleep'
import { bindStartFreshSpawn } from '../pty-connection/spawn/fresh-spawn-start'
import { defersToMainPaneStart } from '../pty-connection/spawn/main-pane-start-request'
import { showFramePatch } from '@/store/slices/tabs/moved-tab-selection'
import type { ConnectPanePtySession } from '../pty-connection/connect-pane-pty-session'
import {
  failCodexAccountRestart,
  prepareCodexAccountRestart,
  retryCodexAccountRestarts
} from './codex-account-restart-execution'
import {
  seed,
  key,
  leaf,
  receipt,
  snapshot,
  mountedSpawnSession
} from './codex-account-restart.test-fixture'

vi.mock('@/lib/agent-session/accounts/agent-account-restart-startup', () => ({
  captureAgentAccountRestartResumeInput: () => ({ providerSession: { id: 'conversation-1' } }),
  buildPaneAccountRestartStartup: () => ({
    command: 'codex resume conversation-1',
    launchAgent: 'codex',
    resumeProviderSession: { id: 'conversation-1' }
  })
}))
const call = vi.fn()
const sessions: ConnectPanePtySession[] = []

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  call.mockReset().mockResolvedValue(snapshot({ ptyId: 'old', incarnationId: 'inc-old' }))
  vi.stubGlobal('window', {
    api: {
      runtime: { call },
      pty: {
        declarePendingPaneSerializer: vi.fn().mockResolvedValue(1),
        clearPendingPaneSerializer: vi.fn().mockResolvedValue(undefined),
        settlePaneSerializer: vi.fn().mockResolvedValue(undefined)
      }
    }
  })
  seed()
})
afterEach(() => {
  for (const session of sessions.splice(0)) {
    session.disposed = true
    session.disposeSpawnDeferral()
    session.waitTeardowns.splice(0).forEach((dispose) => dispose())
  }
  vi.unstubAllGlobals()
})

async function deferredSession() {
  const store = useAppStore.getState()
  store.queuePaneAccountRestarts(['old'], 'codex')
  const request = store.claimCodexAccountRestart(key)
  if (!request) {
    throw new Error('restart was not accepted')
  }
  await prepareCodexAccountRestart(request)
  failCodexAccountRestart(
    codexAccountRestartToken(request),
    receipt(request, 'not-started', 'original'),
    'deferred'
  )
  const retained = new Map([[leaf, 'saved output']])
  const connect = vi.fn()
  const value = mountedSpawnSession(request, retained, connect)
  let bound: string | null = null
  value.transport.getPtyId = () => bound
  Object.assign(value, {
    cols: 80,
    rows: 24,
    keepResumeRecordAfterColdRestoreSpawn: () => {},
    registerEffectiveLaunchConfig: () => {},
    captureTransportOutputCallbacks: (onError: (message: string) => void) => ({
      generation: 1,
      callbacks: { onError },
      launchContext: { startup: request.startup, paneStartup: value.paneStartup }
    }),
    registerPaneSerializerFor: () => {},
    reconcilePtySizeAfterSpawn: () => {}
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the exercised wake and fresh-spawn methods use only the supplied session members.
  const session = value as unknown as ConnectPanePtySession
  installSpawnDeferredSleep(session)
  bindStartFreshSpawn(session)
  session.enterSpawnDeferredSleep('paused', request.startup, {}, true)
  sessions.push(session)
  return {
    session,
    connect,
    retained,
    request,
    bind: (id: string) => {
      bound = id
    }
  }
}

it('wakes a deferred account restart with its captured conversation and conditional host envelope', async () => {
  const { session, connect, retained, request, bind } = await deferredSession()
  useAppStore.setState({
    agentStatusByPaneKey: acceptedAgentStatuses([]),
    sleepingAgentSessionsByPaneKey: {}
  })
  connect.mockImplementation(async (options) => {
    expect(options.command).toBe('codex resume conversation-1')
    expect(options.resumeProviderSession).toEqual({ id: 'conversation-1' })
    expect(options.resumeSpawnIntent).toBe('user-resume')
    expect(options.accountRestart.expected).toEqual({
      kind: 'endpoint',
      ptyId: 'old',
      incarnationId: 'inc-old',
      bindingGeneration: 0
    })
    expect(options.accountRestart.attemptId).not.toBe(request.attemptId)
    expect(options.env.ORCA_AGENT_LAUNCH_TOKEN).toBe(options.accountRestart.attemptId)
    expect(options.onAccountRestartDispatch()).toBe(true)
    const result = { id: 'replacement', incarnationId: 'inc-new' }
    const layout = useAppStore.getState().terminalLayoutsByTabId.tab
    showFramePatch(useAppStore, {
      terminalLayoutsByTabId: {
        tab: { ...layout, ptyIdsByLeafId: { ...layout.ptyIdsByLeafId, [leaf]: 'replacement' } }
      }
    })
    expect(options.shouldContinue(result)).toBe(true)
    bind('replacement')
    return result
  })

  await expect(session.resumeDeferredSpawn()).resolves.toBe('replacement')

  expect(session.transport.getPtyId()).toBe('replacement')
  expect(retained.has(leaf)).toBe(false)
  expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(0)
  expect(session.deps.accountRestartToken).toBeUndefined()
})

it('initializes a retained account pane before choosing its main-layout wake route', async () => {
  const { session } = await deferredSession()
  expect(
    defersToMainPaneStart(session, () => {
      throw new Error('premature start')
    })
  ).toBe(false)
})

it('refuses a late create result after main publishes a different successor', async () => {
  const { session, connect, retained } = await deferredSession()
  connect.mockImplementation(async (options) => {
    expect(options.onAccountRestartDispatch()).toBe(true)
    const layout = useAppStore.getState().terminalLayoutsByTabId.tab
    showFramePatch(useAppStore, {
      terminalLayoutsByTabId: {
        tab: {
          ...layout,
          ptyIdsByLeafId: { ...layout.ptyIdsByLeafId, [leaf]: 'foreign-successor' }
        }
      }
    })
    expect(options.shouldContinue({ id: 'late-result', incarnationId: 'inc-late' })).toBe(false)
    return undefined
  })
  await session.resumeDeferredSpawn()

  expect(useAppStore.getState().terminalLayoutsByTabId.tab.ptyIdsByLeafId?.[leaf]).toBe(
    'foreign-successor'
  )
  expect(retained.get(leaf)).toBe('saved output')
  expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(0)
})

it('keeps an unknown outcome read-only when two wake routes race', async () => {
  const { session, connect, retained, request } = await deferredSession()
  useAppStore
    .getState()
    .updateCodexAccountRestart(codexAccountRestartToken(request), { phase: 'unresolved' })
  const read = Promise.withResolvers<ReturnType<typeof snapshot>>()
  call.mockReturnValue(read.promise)
  const first = session.resumeDeferredSpawn()
  const second = session.resumeDeferredSpawn()
  read.resolve(snapshot({ ptyId: 'old', incarnationId: 'inc-old' }))
  await Promise.all([first, second])

  expect(connect).not.toHaveBeenCalled()
  expect(session.transport.getPtyId()).toBeNull()
  expect(retained.get(leaf)).toBe('saved output')
  expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(1)
})

it('cannot start or clear output after a successor replaces the waiting view', async () => {
  const { session, connect, retained } = await deferredSession()
  const read = Promise.withResolvers<ReturnType<typeof snapshot>>()
  call.mockReturnValue(read.promise)
  const waking = session.resumeDeferredSpawn()
  session.disposed = true
  session.deps.paneTransportsRef.current.set(1, { getPtyId: () => 'successor' } as never)
  read.resolve(snapshot({ ptyId: 'old', incarnationId: 'inc-old' }))
  await waking

  expect(connect).not.toHaveBeenCalled()
  expect(retained.get(leaf)).toBe('saved output')
  expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(1)
})

it('retains a disposed create result and retries by attaching that exact incarnation', async () => {
  const { session, connect } = await deferredSession()
  connect.mockImplementation(async (options) => {
    expect(options.onAccountRestartDispatch()).toBe(true)
    session.disposed = true
    expect(options.shouldContinue({ id: 'committed', incarnationId: 'inc-committed' })).toBe(false)
    return undefined
  })
  await session.resumeDeferredSpawn()
  const unresolved = useAppStore.getState().pendingPaneAccountRestarts[key]
  if (typeof unresolved !== 'object') {
    throw new Error('disposed create result was lost')
  }
  expect(unresolved.resultIncarnationId).toBe('inc-committed')
  call.mockResolvedValue({
    id: 'resolve',
    ok: true,
    result: {
      terminal: {
        handle: 'committed-handle',
        ptyId: 'committed',
        connected: true,
        launchToken: unresolved.attemptId,
        accountRestart: {
          hostEpoch: 'host',
          tabCreatedAt: 1,
          bindingGeneration: 1,
          owner: { ptyId: 'committed', incarnationId: 'inc-committed' }
        }
      }
    }
  })
  await retryCodexAccountRestarts([unresolved])
  const claimed = useAppStore.getState().claimCodexAccountRestart(key)
  if (!claimed) {
    throw new Error('verified result was not claimable')
  }
  await prepareCodexAccountRestart(claimed)
  const retained = new Map([[leaf, 'saved output']])
  const attach = vi.fn()
  const value = mountedSpawnSession(claimed, retained, attach)
  value.transport.getPtyId = () => 'committed'
  Object.assign(value, { handleReattachResult: async () => true })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this exact-reattach branch reads only the supplied session members.
  const successor = value as unknown as ConnectPanePtySession
  sessions.push(successor)
  installSpawnDeferredSleep(successor)
  bindStartFreshSpawn(successor)
  attach.mockImplementation(async (options) => {
    expect(options.sessionId).toBe('committed')
    expect(options.attachOnlyView).toBe(true)
    expect(options.accountRestart).toBeUndefined()
    expect(options.shouldContinue({ id: 'committed', incarnationId: 'inc-committed' })).toBe(true)
    return { id: 'committed', incarnationId: 'inc-committed', isReattach: true }
  })

  await expect(successor.startFreshSpawn()).resolves.toBe('committed')
  expect(retained.has(leaf)).toBe(false)
  expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(0)
})
