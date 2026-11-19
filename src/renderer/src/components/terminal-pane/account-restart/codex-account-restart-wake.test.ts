import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import { codexAccountRestartToken } from '@/store/terminals/codex-account-restart-continuation'
import { selectCodexStaleSessionCount } from '@/components/status-bar/accounts/codex-restart-status-summary'
import { installSpawnDeferredSleep } from '../pty-connection/spawn/spawn-deferred-sleep'
import { bindStartFreshSpawn } from '../pty-connection/spawn/fresh-spawn-start'
import { defersToMainPaneStart } from '../pty-connection/spawn/main-pane-start-request'
import { runDeferredSessionAttach } from '../pty-connection/deferred-session-attach'
import { showFramePatch } from '@/store/slices/tabs/moved-tab-selection'
import {
  admitTerminalNoticeLifetime,
  retireTerminalNoticeLifetime
} from '../provider-notices/terminal-notice-lifetime'
import { routeCodexAccountRestartWake } from './codex-account-restart-wake'
import type { CodexAccountRestart } from '@/store/terminals/terminal-contracts'
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
  captureAgentAccountRestartResumeInput: () => ({
    providerSession: { key: 'session_id', id: 'conversation-1' }
  }),
  buildPaneAccountRestartStartup: () => ({
    command: 'codex resume conversation-1',
    launchAgent: 'codex',
    resumeProviderSession: { key: 'session_id', id: 'conversation-1' }
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
  return mountSession(request)
}

function mountSession(request: CodexAccountRestart, arm = true) {
  const retained = new Map([[leaf, 'saved output']])
  const connect = vi.fn()
  const value = mountedSpawnSession(request, retained, connect)
  let bound: string | null = null
  value.transport.getPtyId = () => bound
  Object.assign(value, {
    allowInitialIdleCacheSeed: false,
    buildColdRestoreAgentResumeStartup: () => null,
    beginReattachLiveDataDeferral: () => {},
    handleReattachResult: async () => true,
    settlePaneSerializerAfterReplay: async () => {},
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
  if (arm) {
    session.enterSpawnDeferredSleep('paused', request.startup, {}, true)
  }
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

it.each(['deferred overlay', 'legacy attach'] as const)(
  'resumes the captured conversation through the conditional host envelope from %s',
  async (entry) => {
    const { session, connect, retained, request, bind } = await deferredSession()
    useAppStore.setState({
      agentStatusByPaneKey: acceptedAgentStatuses([]),
      sleepingAgentSessionsByPaneKey: {}
    })
    connect.mockImplementation(async (options) => {
      expect(options.command).toBe('codex resume conversation-1')
      expect(options.resumeProviderSession).toEqual({ key: 'session_id', id: 'conversation-1' })
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

    if (entry === 'legacy attach') {
      session.legacyRelayBridgePtyId = 'old'
      runDeferredSessionAttach(session)
      await vi.waitFor(() => expect(retained.has(leaf)).toBe(false))
    } else {
      await expect(session.resumeDeferredSpawn()).resolves.toBe('replacement')
    }

    expect(session.transport.getPtyId()).toBe('replacement')
    expect(retained.has(leaf)).toBe(false)
    expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(0)
    expect(session.deps.accountRestartToken).toBeUndefined()
  }
)

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
  let lateDecision: boolean | undefined
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
    lateDecision = options.shouldContinue({ id: 'late-result', incarnationId: 'inc-late' })
    return undefined
  })
  await session.resumeDeferredSpawn()
  expect(lateDecision).toBe(false)

  expect(useAppStore.getState().terminalLayoutsByTabId.tab.ptyIdsByLeafId?.[leaf]).toBe(
    'foreign-successor'
  )
  expect(retained.get(leaf)).toBe('saved output')
  expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(1)
})

it('keeps an unknown outcome read-only when two wake routes race', async () => {
  const { session, connect, retained, request } = await deferredSession()
  useAppStore
    .getState()
    .updateCodexAccountRestart(codexAccountRestartToken(request), { phase: 'unresolved' })
  const read = Promise.withResolvers<ReturnType<typeof snapshot>>()
  const reading = Promise.withResolvers<void>()
  call.mockImplementation(() => {
    reading.resolve()
    return read.promise
  })
  const first = session.resumeDeferredSpawn()
  await reading.promise
  runDeferredSessionAttach(session)
  read.resolve(snapshot({ ptyId: 'old', incarnationId: 'inc-old' }))
  await first

  expect(connect).not.toHaveBeenCalled()
  expect(session.transport.getPtyId()).toBeNull()
  expect(retained.get(leaf)).toBe('saved output')
  expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(1)
})

it.each([
  { connected: true, launchToken: 'foreign-attempt', attention: 0 },
  { connected: false, launchToken: 'foreign-attempt', attention: 1 },
  { connected: true, launchToken: undefined, attention: 1 }
])('reconciles unknown ownership with evidence %j', async (control) => {
  const { session, connect } = await deferredSession()
  connect.mockImplementation(async (options) => {
    expect(options.onAccountRestartDispatch()).toBe(true)
    options.onAccountRestartFailure(new Error('response unavailable'))
    return undefined
  })
  await session.resumeDeferredSpawn()
  const unknown = useAppStore.getState().pendingPaneAccountRestarts[key]
  if (typeof unknown !== 'object') {
    throw new Error('unknown attempt was lost')
  }
  const resolved = snapshot({ ptyId: 'foreign-owner', incarnationId: 'inc-foreign' }, 1)
  call.mockResolvedValue({
    ...resolved,
    result: {
      terminal: {
        ...resolved.result.terminal,
        ptyId: 'foreign-owner',
        connected: control.connected,
        launchToken: control.launchToken
      }
    }
  })
  connect.mockClear()

  await retryCodexAccountRestarts([unknown])

  expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(control.attention)
  expect(connect).not.toHaveBeenCalled()
  expect(useAppStore.getState().terminalLayoutsByTabId.tab.ptyIdsByLeafId?.[leaf]).toBe('old')
})

it('cannot start or clear output after a successor replaces the waiting view', async () => {
  const { session, connect, retained } = await deferredSession()
  const read = Promise.withResolvers<ReturnType<typeof snapshot>>()
  call.mockReturnValue(read.promise)
  const waking = session.resumeDeferredSpawn()
  session.disposed = true
  session.deps.paneTransportsRef.current.set(1, {
    ...session.transport,
    getPtyId: () => 'successor'
  })
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

it('re-arms a receipt-backed paused restart after its view is replaced and resumes it once', async () => {
  const first = await deferredSession()
  first.session.disposed = true
  first.session.disposeSpawnDeferral()
  const current = useAppStore.getState().pendingPaneAccountRestarts[key]
  if (typeof current !== 'object') {
    throw new Error('missing retained restart')
  }
  const replacement = mountSession(current, false)
  replacement.session.deps.accountRestartToken = undefined
  await routeCodexAccountRestartWake(replacement.session)
  expect(replacement.connect).not.toHaveBeenCalled()
  const dispatched: unknown[] = []
  replacement.connect.mockImplementation(async (options) => {
    dispatched.push(options.accountRestart)
    options.onAccountRestartDispatch()
    const result = { id: 'replacement', incarnationId: 'inc-new' }
    if (!options.shouldContinue(result)) {
      return undefined
    }
    replacement.bind(result.id)
    return result
  })
  await replacement.session.resumeDeferredSpawn()
  await replacement.session.resumeDeferredSpawn()
  expect(dispatched).toHaveLength(1)
  expect(dispatched[0]).toMatchObject({
    expected: { kind: 'endpoint', ptyId: 'old', incarnationId: 'inc-old' }
  })
  expect(replacement.session.transport.getPtyId()).toBe('replacement')
  expect(replacement.retained.has(leaf)).toBe(false)
  expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(0)
})

it('reattaches a proven undispatched original without resuming or creating on an unsupported host', async () => {
  const first = await deferredSession()
  first.session.disposed = true
  first.session.disposeSpawnDeferral()
  useAppStore.getState().updateCodexAccountRestart(codexAccountRestartToken(first.request), {
    phase: 'preparing',
    receipt: undefined
  })
  failCodexAccountRestart(
    codexAccountRestartToken(first.request),
    'terminal_account_restart_unsupported',
    'failed',
    { notDispatched: true }
  )
  const current = useAppStore.getState().pendingPaneAccountRestarts[key]
  if (typeof current !== 'object') {
    throw new Error('missing failure')
  }
  const view = mountSession(current, false)
  view.session.deps.accountRestartToken = undefined
  view.session.buildColdRestoreAgentResumeStartup = () => first.request.startup as never
  const attachments: unknown[] = []
  view.connect.mockImplementation(async (options) => {
    attachments.push({
      sessionId: options.sessionId,
      attachOnlyView: options.attachOnlyView,
      command: options.command,
      accountRestart: options.accountRestart
    })
    const result = { id: 'old', incarnationId: 'inc-old', isReattach: true }
    if (!options.shouldContinue(result)) {
      return undefined
    }
    view.bind('old')
    return result
  })
  await routeCodexAccountRestartWake(view.session)
  expect(attachments).toEqual([
    { sessionId: 'old', attachOnlyView: true, command: undefined, accountRestart: undefined }
  ])
  expect(view.session.transport.getPtyId()).toBe('old')
  expect(view.retained.get(leaf)).toBe('saved output')
  expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(1)
})

it.each(['connected', 'disconnected', 'removed during read'] as const)(
  'requires current connected foreign ownership: %s',
  async (control) => {
    const { session, connect } = await deferredSession()
    const state = useAppStore.getState()
    const foreignLeaf = '00000000-0000-4000-8000-000000000003'
    const foreignKey = `foreign:${foreignLeaf}`
    useAppStore.setState({
      tabsByWorktree: {
        wt: [
          ...state.tabsByWorktree.wt,
          { ...state.tabsByWorktree.wt[0], id: 'foreign', ptyId: 'foreign-pty' }
        ]
      },
      ptyIdsByTabId: { ...state.ptyIdsByTabId, foreign: ['foreign-pty'] },
      terminalLayoutsByTabId: {
        ...state.terminalLayoutsByTabId,
        foreign: {
          root: { type: 'leaf', leafId: foreignLeaf },
          activeLeafId: foreignLeaf,
          expandedLeafId: null,
          ptyIdsByLeafId: { [foreignLeaf]: 'foreign-pty' }
        }
      },
      agentStatusByPaneKey: acceptedAgentStatuses([
        [
          foreignKey,
          {
            state: 'waiting',
            prompt: '',
            updatedAt: 1,
            stateStartedAt: 1,
            stateHistory: [],
            agentType: 'codex',
            paneKey: foreignKey,
            providerSession: { key: 'session_id', id: 'conversation-1' }
          }
        ]
      ])
    })
    const foreignLifetime = admitTerminalNoticeLifetime('foreign-pty', {
      incarnationId: 'inc-foreign',
      fresh: true
    })
    call.mockImplementation(async () => {
      if (control === 'removed during read') {
        useAppStore.setState({
          ptyIdsByTabId: { ...useAppStore.getState().ptyIdsByTabId, foreign: [] }
        })
      }
      const answer = snapshot({ ptyId: 'foreign-pty', incarnationId: 'inc-foreign' })
      return {
        ...answer,
        result: {
          terminal: {
            ...answer.result.terminal,
            ptyId: 'foreign-pty',
            connected: control !== 'disconnected'
          }
        }
      }
    })
    try {
      await session.resumeDeferredSpawn()
      expect(connect).not.toHaveBeenCalled()
      expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(
        control === 'connected' ? 0 : 1
      )
      expect(
        useAppStore.getState().terminalLayoutsByTabId.foreign.ptyIdsByLeafId?.[foreignLeaf]
      ).toBe('foreign-pty')
    } finally {
      retireTerminalNoticeLifetime(foreignLifetime)
    }
  }
)
