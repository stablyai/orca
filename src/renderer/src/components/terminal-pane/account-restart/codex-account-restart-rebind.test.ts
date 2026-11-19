import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { ConnectPanePtySession } from '../pty-connection/connect-pane-pty-session'
import { installActivePanePtyBinding } from '../pty-connection/lifecycle/active-pane-pty-binding'
import { captureCodexAccountRestartConnection } from './codex-account-restart-connection'
import {
  prepareCodexAccountRestart,
  retryCodexAccountRestarts
} from './codex-account-restart-execution'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import { formatAccountRestartFailure } from '../../../../../shared/terminal/pty/lifecycle/account-restart-contract'
import {
  seed,
  key,
  leaf,
  snapshot,
  mountedSpawnSession
} from './codex-account-restart.test-fixture'

vi.mock('@/lib/agent-session/accounts/agent-account-restart-startup', () => ({
  captureAgentAccountRestartResumeInput: () => null,
  buildPaneAccountRestartStartup: () => ({ command: 'codex', launchAgent: 'codex' })
}))
vi.mock('@/runtime/sync-runtime-graph/graph-sync-scheduler', () => ({
  scheduleRuntimeGraphSync: () => {}
}))
vi.mock('@/lib/agent-session/accounts/codex/codex-stale-pane-sweep', () => ({
  notifyCodexPaneBoundForStaleSweep: () => {}
}))

afterEach(() => vi.unstubAllGlobals())

it.each(['structured RPC', 'long IPC'] as const)(
  'retains a terminal stop receipt through %s failure capture',
  async (boundary) => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    vi.stubGlobal('window', {
      api: {
        runtime: {
          call: vi.fn().mockResolvedValue(snapshot({ ptyId: 'old', incarnationId: 'inc-old' }))
        }
      }
    })
    seed()
    useAppStore.getState().queuePaneAccountRestarts(['old'], 'codex')
    const request = useAppStore.getState().claimCodexAccountRestart(key)
    if (!request) {
      throw new Error('restart was not accepted')
    }
    await prepareCodexAccountRestart(request)
    const retained = new Map([[leaf, 'saved output']])
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies the captured connection and settlement members exercised here.
    const session = mountedSpawnSession(
      request,
      retained,
      async () => undefined
    ) as unknown as ConnectPanePtySession
    const connection = captureCodexAccountRestartConnection(session)
    if (!connection) {
      throw new Error('restart connection was not captured')
    }
    const options = {
      url: '',
      cols: 80,
      rows: 24,
      callbacks: {},
      ...connection.options(() => true)
    }
    options.onAccountRestartDispatch?.()
    const accountRestart = {
      v: 1 as const,
      requestId: request.requestId,
      attemptId: request.attemptId,
      stop: 'confirmed-retired' as const,
      outcome: 'terminal' as const,
      current: { kind: 'empty' as const, bindingGeneration: 1 }
    }
    connection.captureFailure(
      boundary === 'structured RPC'
        ? new RuntimeRpcCallError({
            id: 'create',
            ok: false,
            error: { code: 'internal', message: 'launch refused', data: { accountRestart } }
          })
        : new Error(formatAccountRestartFailure('x'.repeat(5000), accountRestart))
    )
    connection.settle(null, 1, options, () => true)
    const failed = useAppStore.getState().pendingPaneAccountRestarts[key]
    expect(typeof failed === 'object' && failed.phase).toBe('failed')
    expect(typeof failed === 'object' && failed.receipt?.stop).toBe('confirmed-retired')
    expect(typeof failed === 'object' && failed.condition?.expected).toEqual({
      kind: 'empty',
      bindingGeneration: 1
    })
    expect(retained.get(leaf)).toBe('saved output')
  }
)

it('allows normal handle recovery after successful restart but refuses its obsolete callback', async () => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  vi.stubGlobal('window', {
    api: {
      runtime: {
        call: vi.fn().mockResolvedValue(snapshot({ ptyId: 'old', incarnationId: 'inc-old' }))
      }
    }
  })
  seed()
  const state = useAppStore.getState()
  state.queuePaneAccountRestarts(['old'], 'codex')
  const request = state.claimCodexAccountRestart(key)
  if (!request) {
    throw new Error('restart was not accepted')
  }
  await prepareCodexAccountRestart(request)
  let endpoint: string | null = null
  const value = mountedSpawnSession(
    request,
    new Map([[leaf, 'saved output']]),
    async () => undefined
  )
  value.transport.getPtyId = () => endpoint
  Object.defineProperty(value, 'activePanePtyBinding', { value: null, writable: true })
  const noop = () => {}
  Object.assign(value, {
    bindProcessExitState: noop,
    windowsPtyModel: { apply: noop },
    setPanePtyFitBinding: noop,
    registerSideEffectFactConsumerForPty: noop,
    syncHiddenRendererPtyDelivery: noop,
    syncPanePtyLayoutBinding: (id: string) =>
      useAppStore.getState().replaceTerminalLayoutPanePtyId('tab', leaf, id),
    agentCompletionCoordinator: { startProcessTracking: noop },
    sampleVisiblePaneForegroundAgent: noop
  })
  Object.assign(value.deps, { updateTabPtyId: useAppStore.getState().updateTabPtyId })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies every active binding and captured account connection member exercised here.
  const session = value as unknown as ConnectPanePtySession
  installActivePanePtyBinding(session)
  const connection = captureCodexAccountRestartConnection(session)
  if (!connection) {
    throw new Error('restart connection was not captured')
  }
  const options = { url: '', cols: 80, rows: 24, callbacks: {}, ...connection.options(() => true) }
  const obsolete = options.isAccountRestartCurrent
  endpoint = 'remote:env@@restarted'
  expect(connection.continue({ id: endpoint, incarnationId: 'inc-new' })).toBe(true)
  expect(session.bindActivePanePty(endpoint)).toBe(true)
  connection.settle(endpoint, 1, options, () => true)

  endpoint = 'remote:env@@recovered'
  session.onPtyRebind(endpoint, 'remote:env@@restarted', 'inc-recovered')

  expect(useAppStore.getState().terminalLayoutsByTabId.tab.ptyIdsByLeafId?.[leaf]).toBe(
    'remote:env@@recovered'
  )
  expect(useAppStore.getState().ptyIdsByTabId.tab).toEqual(['remote:env@@recovered', 'sibling'])
  expect(session.activePanePtyBinding).toBe('remote:env@@recovered')
  expect(session.remotePtyIncarnationId).toBe('inc-recovered')
  expect(obsolete?.()).toBe(false)
  expect(connection.continue({ id: 'remote:env@@late-old', incarnationId: 'inc-late' })).toBe(false)
  expect(options.isAccountRestartCurrent).toBeUndefined()
  connection.settle(null, 1, options, () => false)
  expect(options.shouldContinue?.()).toBe(true)
})

it.each(['matching', 'different owner', 'same ID successor', 'disconnected'] as const)(
  'checks current host result authority before accepting a late account reply: %s',
  async (authority) => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    const call = vi.fn().mockResolvedValue(snapshot({ ptyId: 'old', incarnationId: 'inc-old' }))
    vi.stubGlobal('window', { api: { runtime: { call } } })
    seed()
    useAppStore.getState().queuePaneAccountRestarts(['old'], 'codex')
    const request = useAppStore.getState().claimCodexAccountRestart(key)
    if (!request) {
      throw new Error('restart was not accepted')
    }
    await prepareCodexAccountRestart(request)
    const saved = new Map([[leaf, 'saved output']])
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture provides the captured connection's startup, token and settlement ports.
    const session = mountedSpawnSession(
      request,
      saved,
      async () => undefined
    ) as unknown as ConnectPanePtySession
    const connection = captureCodexAccountRestartConnection(session)
    if (!connection) {
      throw new Error('restart connection was not captured')
    }
    const options = { url: '', callbacks: {}, ...connection.options(() => true) }
    options.onAccountRestartDispatch?.()
    const result = { id: 'created', incarnationId: 'inc-created' }
    expect(connection.continue(result)).toBe(true)
    const owner = {
      ptyId: authority === 'different owner' ? 'winner' : 'created',
      incarnationId: authority === 'same ID successor' ? 'inc-successor' : 'inc-created'
    }
    const resolved = snapshot(owner, 1)
    call.mockResolvedValue({
      ...resolved,
      result: {
        terminal: {
          ...resolved.result.terminal,
          ...owner,
          connected: authority !== 'disconnected',
          agentResumeRefused: 'chat-home'
        }
      }
    })
    expect(await options.verifyAccountRestartResult?.(result)).toBe(authority === 'matching')
    expect(saved.get(leaf)).toBe('saved output')
    if (authority === 'different owner' || authority === 'same ID successor') {
      connection.settle(null, 1, options, () => true)
      expect(session.deps.accountRestartToken).toBeUndefined()
      expect(connection.continue(result)).toBe(false)
      expect(options.isAccountRestartCurrent).toBeUndefined()
    }
  }
)

it('does not publish attach success when account settlement rejects a mismatched incarnation', async () => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  vi.stubGlobal('window', {
    api: {
      runtime: {
        call: vi.fn().mockResolvedValue(snapshot({ ptyId: 'old', incarnationId: 'inc-old' }))
      }
    }
  })
  seed()
  useAppStore.getState().queuePaneAccountRestarts(['old'], 'codex')
  const request = useAppStore.getState().claimCodexAccountRestart(key)
  if (!request) {
    throw new Error('restart was not accepted')
  }
  await prepareCodexAccountRestart(request)
  const value = mountedSpawnSession(request, new Map(), async () => undefined, 'inc-successor')
  value.transport.getPtyId = () => 'created'
  const settled = vi.fn()
  value.settlePaneAttachAttempt = settled
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture supplies the connection settlement ports under test.
  const connection = captureCodexAccountRestartConnection(value as unknown as ConnectPanePtySession)
  if (!connection) {
    throw new Error('restart was not captured')
  }
  const options = { url: '', callbacks: {}, ...connection.options(() => true) }
  connection.continue({ id: 'created', incarnationId: 'inc-created' })
  connection.settle('created', 1, options, () => true)
  expect(settled).not.toHaveBeenCalled()
  expect(useAppStore.getState().pendingPaneAccountRestarts[key]).toMatchObject({
    phase: 'unresolved',
    resultPtyId: 'created'
  })
})

it('keeps a disconnected committed result available until its exact owner reconnects', async () => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  const call = vi.fn().mockResolvedValue(snapshot({ ptyId: 'old', incarnationId: 'inc-old' }))
  vi.stubGlobal('window', { api: { runtime: { call } } })
  seed()
  useAppStore.getState().queuePaneAccountRestarts(['old'], 'codex')
  const request = useAppStore.getState().claimCodexAccountRestart(key)
  if (!request) {
    throw new Error('restart was not accepted')
  }
  await prepareCodexAccountRestart(request)
  const value = mountedSpawnSession(request, new Map(), async () => undefined)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture supplies the captured connection ports exercised here.
  const connection = captureCodexAccountRestartConnection(value as unknown as ConnectPanePtySession)
  if (!connection) {
    throw new Error('restart was not captured')
  }
  const options = { url: '', callbacks: {}, ...connection.options(() => true) }
  options.onAccountRestartDispatch?.()
  connection.continue({ id: 'created', incarnationId: 'inc-created' })
  value.disposed = true
  connection.settle(null, 1, options, () => false)
  const answer = snapshot({ ptyId: 'created', incarnationId: 'inc-created' }, 1)
  for (const connected of [false, true]) {
    call.mockResolvedValue({
      ...answer,
      result: {
        terminal: {
          ...answer.result.terminal,
          ptyId: 'created',
          connected,
          launchToken: request.attemptId
        }
      }
    })
    const current = useAppStore.getState().pendingPaneAccountRestarts[key]
    if (typeof current !== 'object') {
      throw new Error('committed result was lost')
    }
    await retryCodexAccountRestarts([current])
    expect(useAppStore.getState().pendingPaneAccountRestarts[key]).toMatchObject({
      phase: connected ? 'accepted' : 'unresolved',
      resultPtyId: 'created',
      resultIncarnationId: 'inc-created'
    })
  }
  expect(useAppStore.getState().terminalLayoutsByTabId.tab.ptyIdsByLeafId?.[leaf]).toBe('old')
})
