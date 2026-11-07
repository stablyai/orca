import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GeneratedAgentInputNotices } from '../../../main/runtime/generated-agent-input-notices'
import { GENERATED_INPUT_METHODS } from '../../../main/runtime/rpc/methods/generated-input'
import { eraseRpcMethods, type RpcContext, type RpcMethod } from '../../../main/runtime/rpc/core'
import { RegisterGeneratedInputNoticeParams } from '../../../shared/rpc-contract/generated-input-params'
import { toRemoteRuntimePtyId } from '../../../shared/remote-runtime/remote-runtime-pty-id'
import { GENERATED_INPUT_RUNTIME_CAPABILITY } from '../../../shared/generated-terminal-input'
import {
  GENERATED_INPUT_FENCED_SEND_RUNTIME_CAPABILITY,
  GENERATED_INPUT_REGISTER_RUNTIME_CAPABILITY
} from '../../../shared/terminal-runtime-capabilities'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'
import {
  addEnvironmentFromPairingCode,
  resolveEnvironment,
  updateEnvironmentFromPairingCode
} from '../../../shared/runtime-environment-store'
import { encodePairingOffer } from '../../../shared/pairing'
import { REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY } from '../../../shared/host-runtime-capabilities'
import {
  closeSharedControlTestServers,
  createSharedControlTestServer
} from '../../../shared/remote-runtime/control/remote-runtime-shared-control-test-server'
import { channelHandlerLookup } from '../../../main/ipc/runtime-environments/runtime-environments-ipc-test-harness'
import { resetSharedControlSupport } from '../../../main/ipc/runtime-environments/runtime-environment-shared-control-support'
import { closeRemoteRuntimeSharedControlConnection } from '../../../main/ipc/runtime-environments/runtime-environment-request-connections'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'

const h = vi.hoisted(() => ({ handle: vi.fn() }))
// Main's IPC registration only; every handler, the ingress and the routing below are real.
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  BrowserWindow: { fromWebContents: vi.fn(), getAllWindows: () => [] },
  ipcMain: { handle: h.handle, on: vi.fn(), removeHandler: vi.fn(), removeAllListeners: vi.fn() }
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ ptyIdsByTabId: {}, tabsByWorktree: {}, terminalLayoutsByTabId: {} }),
    subscribe: () => () => {}
  }
}))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn(), tuiAgentToAgentKind: () => 'codex' }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('sonner', () => ({ toast: { message: vi.fn(), dismiss: vi.fn() } }))
// An older host's output stream is observation only; its multiplexer is not this contract.
vi.mock('@/runtime/runtime-terminal-stream', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  subscribeToRuntimeTerminalData: async () => () => {}
}))

const { registerRuntimeHandlers } = await import('../../../main/ipc/runtime')
const { registerRuntimeEnvironmentPassiveHandlers } =
  await import('../../../main/ipc/runtime-environments/runtime-environment-connectivity-handlers')
const { registerRuntimeEnvironmentSubscriptionHandlers } =
  await import('../../../main/ipc/runtime-environments/runtime-environment-subscription-handlers')
const { subscribeRuntimeEnvironmentFromPreload } =
  await import('../../../preload/runtime-environment-subscriptions')
const { deliverGeneratedPaste } = await import('./agent-paste-draft')
const { pasteDraftToAgentPtyWhenReady } = await import('./agent-paste-draft')
const { sendGeneratedTerminalInputToHandle } =
  await import('@/runtime/generated-terminal-input-client')
const {
  callRuntimeRpc,
  ensureRuntimeEnvironmentCompatible,
  getRuntimeEnvironmentCapabilityStatus
} = await import('@/runtime/runtime-rpc-client')
const {
  clearRecentRuntimeCompatibilityFailure,
  clearRuntimeCompatibilityCache,
  compatibilityEntry,
  rememberRuntimeEnvironmentCompatibility,
  runtimeCompatibilityChecks
} = await import('@/runtime/runtime-compatibility-cache')

const SEND = 'terminal.sendGeneratedInput'
const register = eraseRpcMethods(GENERATED_INPUT_METHODS).find(
  (method): method is RpcMethod =>
    method.name === 'terminal.generatedInputNotices.register' && !('stream' in method)
)!
const status = (runtimeId: string, capabilities: string[]) => ({
  runtimeId,
  protocolVersion: RUNTIME_PROTOCOL_VERSION,
  minCompatibleMobileVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  capabilities
})
const answer = (result: unknown, runtimeId = 'h1') => ({
  id: 'x',
  ok: true,
  result,
  _meta: { runtimeId }
})

let notices: GeneratedAgentInputNotices
let hostCall: ReturnType<typeof vi.fn>
let hostSubscribe: ReturnType<typeof vi.fn>

beforeEach(() => {
  notices = new GeneratedAgentInputNotices()
  hostCall = vi.fn()
  hostSubscribe = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the register method reads only the notice store, runtime id and caller identity.
  const local = {
    runtime: { generatedInputNotices: notices, getRuntimeId: () => 'local-runtime' },
    noticeOrigin: 'window',
    connectionId: 'doc',
    clientCapabilities: [GENERATED_INPUT_REGISTER_RUNTIME_CAPABILITY]
  } as unknown as RpcContext
  vi.stubGlobal('window', {
    setTimeout,
    clearTimeout,
    api: {
      // This window's own runtime: the real notice owner behind its real register method.
      runtime: {
        call: async ({ params }: { params: unknown }) =>
          answer(await register.handler(RegisterGeneratedInputNoticeParams.parse(params), local))
      },
      runtimeEnvironments: { call: hostCall, subscribe: hostSubscribe }
    }
  })
})

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
  resetSharedControlSupport()
  await closeSharedControlTestServers()
  clearRuntimeCompatibilityCache()
  replaceRuntimeEnvironmentRevisions([])
  vi.unstubAllGlobals()
})

// XR10: a paired host's ordinary status read fails before any terminal request. Nothing was
// sent, so the startup draft's own recovery runs now, in this document, under its accepted id.
it('recovers a draft whose status read failed as not sent, at once and under its id', async () => {
  hostCall.mockRejectedValue(new Error('offline'))
  const onTimeout = vi.fn()
  const delivered = await pasteDraftToAgentPtyWhenReady({
    ptyId: toRemoteRuntimePtyId('host-terminal', 'env'),
    content: 'exact\r\nprompt 😀',
    agent: 'codex',
    submit: true,
    onTimeout,
    operationId: 'op-cold'
  })
  expect(delivered).toBe(false)
  expect(hostCall.mock.calls.map(([args]) => args.method)).toEqual(['status.get'])
  expect(onTimeout).toHaveBeenCalledExactlyOnceWith('not-sent', true, 'op-cold')
  expect(notices.visibleTo('op-cold', 'window')).toBe(true)
  expect(notices.noticeOf('op-cold')).toMatchObject({
    text: 'exact\r\nprompt 😀',
    certainty: 'not-sent'
  })
  // A host that answers without the transaction still takes the old path, not this one.
  hostCall.mockReset()
  hostCall.mockResolvedValue(answer(status('h1', [])))
  await expect(
    sendGeneratedTerminalInputToHandle(
      { kind: 'environment', environmentId: 'env' },
      'host-terminal',
      {
        text: 'x',
        submit: true
      }
    )
  ).resolves.toBeNull()
})

// XR9: a request routed by H1's verified status meets H2, which refuses its schema. It is never
// retried; the next independent request reads H2's ordinary status and takes its supported route.
it('lets only authenticated evidence from another runtime retire the status it was routed by', async () => {
  const fenced = status('h1', [
    GENERATED_INPUT_RUNTIME_CAPABILITY,
    GENERATED_INPUT_REGISTER_RUNTIME_CAPABILITY,
    GENERATED_INPUT_FENCED_SEND_RUNTIME_CAPABILITY
  ])
  const target = { kind: 'environment' as const, environmentId: 'env' }
  const request = { text: 'exact', submit: true, retainNotice: true, operationId: 'first' }
  const refusal = (runtimeId: string) => ({
    id: SEND,
    ok: false,
    error: { code: 'invalid_argument', message: 'terminal must be a string' },
    _meta: { runtimeId }
  })
  rememberRuntimeEnvironmentCompatibility('env', compatibilityEntry(fenced as never))
  rememberRuntimeEnvironmentCompatibility('other', compatibilityEntry(status('o1', []) as never))
  // The same runtime's own invalid argument says nothing about a replacement.
  hostCall.mockResolvedValueOnce(refusal('h1'))
  await expect(sendGeneratedTerminalInputToHandle(target, 'terminal', request)).resolves.toBe(
    'unconfirmed'
  )
  expect(runtimeCompatibilityChecks.get('env')?.status?.runtimeId).toBe('h1')

  hostCall.mockReset()
  hostCall.mockResolvedValueOnce(refusal('h2'))
  await expect(sendGeneratedTerminalInputToHandle(target, 'terminal', request)).resolves.toBe(
    'unconfirmed'
  )
  // Never resent, downgraded or retargeted; only H1's stale status is gone.
  expect(hostCall).toHaveBeenCalledOnce()
  expect(runtimeCompatibilityChecks.has('env')).toBe(false)
  expect(runtimeCompatibilityChecks.get('other')?.status?.runtimeId).toBe('o1')

  hostCall.mockReset()
  hostCall.mockImplementation(async ({ method }: { method: string }) =>
    method === 'status.get'
      ? answer(status('h2', [GENERATED_INPUT_RUNTIME_CAPABILITY]), 'h2')
      : answer({ delivery: { outcome: 'delivered' } }, 'h2')
  )
  await expect(
    sendGeneratedTerminalInputToHandle(target, 'terminal', { ...request, operationId: 'second' })
  ).resolves.toBe('delivered')
  expect(hostCall.mock.calls.map(([args]) => [args.method, args.params?.terminal])).toEqual([
    ['status.get', undefined],
    [SEND, 'terminal']
  ])
  // The id still follows the request inside this desktop, never onto the old host's wire.
  expect(hostCall.mock.calls[1][0]).toMatchObject({ generatedInputOperationId: 'second' })
  expect(hostCall.mock.calls[1][0].params).not.toHaveProperty('operationId')

  // A late refusal of the earlier status never removes the newer one that replaced it.
  rememberRuntimeEnvironmentCompatibility('env', compatibilityEntry(fenced as never))
  const late = Promise.withResolvers<unknown>()
  hostCall.mockReset()
  hostCall.mockReturnValueOnce(late.promise)
  const pending = sendGeneratedTerminalInputToHandle(target, 'terminal', request)
  await vi.waitFor(() => expect(hostCall).toHaveBeenCalledOnce())
  const newer = compatibilityEntry(status('h3', [GENERATED_INPUT_RUNTIME_CAPABILITY]) as never)
  rememberRuntimeEnvironmentCompatibility('env', newer)
  late.resolve(refusal('h2'))
  await pending
  expect(runtimeCompatibilityChecks.get('env')).toBe(newer)
})

// A status that crossed a managed repair answers for neither pairing: the request is refused
// before any terminal call, and the next request learns the host afresh.
it('refuses to route by a status its own selection crossed a repair for', async () => {
  hostCall.mockResolvedValueOnce({
    ...answer(status('h2', [GENERATED_INPUT_RUNTIME_CAPABILITY]), 'h2'),
    selectedPairing: { revision: 1, crossedRepair: true }
  })
  await expect(
    sendGeneratedTerminalInputToHandle({ kind: 'environment', environmentId: 'env' }, 'terminal', {
      text: 'x',
      submit: true,
      operationId: 'op-crossed'
    })
  ).resolves.toBe('not-sent')
  expect(hostCall.mock.calls.map(([args]) => args.method)).toEqual(['status.get'])
  expect(runtimeCompatibilityChecks.has('env')).toBe(false)
})

// A published status that answers a pending check carries its main snapshot's pairing.
it('routes by a published status over the pairing of the snapshot that published it', async () => {
  rememberRuntimeEnvironmentCompatibility('env', compatibilityEntry())
  clearRecentRuntimeCompatibilityFailure('env', {
    status: status('h1', [GENERATED_INPUT_RUNTIME_CAPABILITY]) as never,
    snapshot: { pairingRevision: 4 }
  })
  hostCall.mockResolvedValueOnce(answer({ delivery: { outcome: 'delivered' } }))
  await expect(
    sendGeneratedTerminalInputToHandle({ kind: 'environment', environmentId: 'env' }, 'terminal', {
      text: 'x',
      submit: true,
      operationId: 'op-published'
    })
  ).resolves.toBe('delivered')
  expect(hostCall.mock.calls[0][0]).toMatchObject({
    method: SEND,
    expectedEnvironmentPairingRevision: 4,
    generatedInputOperationId: 'op-published'
  })
})

// XR14 at the selection seam: a joined status is the request's own once chosen. Dropping or
// replacing the reusable slot never starts another read for it; ordinary readers still refresh.
it('ends a request on its own joined status, whatever then happens to the cache slot', async () => {
  const held = Promise.withResolvers<unknown>()
  hostCall.mockReturnValueOnce(held.promise)
  const ordinary = getRuntimeEnvironmentCapabilityStatus('env').catch(() => null)
  const target = { kind: 'environment' as const, environmentId: 'env' }
  const rejected = sendGeneratedTerminalInputToHandle(target, 'terminal', {
    text: 'x',
    submit: true,
    operationId: 'op-dropped'
  })
  // The slot is dropped (a catalog clear) and the selected read then fails: nothing more is asked.
  clearRuntimeCompatibilityCache('env')
  held.reject(new Error('offline'))
  await expect(rejected).resolves.toBe('not-sent')
  await ordinary
  expect(hostCall).toHaveBeenCalledOnce()

  // A replaced selection whose answer crossed a repair is refused; the newer entry survives.
  hostCall.mockReset()
  const crossed = Promise.withResolvers<unknown>()
  hostCall.mockReturnValueOnce(crossed.promise)
  const prober = getRuntimeEnvironmentCapabilityStatus('env')
  const refused = sendGeneratedTerminalInputToHandle(target, 'terminal', {
    text: 'x',
    submit: true,
    operationId: 'op-crossed-joined'
  })
  const newer = compatibilityEntry(status('h3', [GENERATED_INPUT_RUNTIME_CAPABILITY]) as never)
  rememberRuntimeEnvironmentCompatibility('env', newer)
  crossed.resolve({
    ...answer(status('h2', [GENERATED_INPUT_RUNTIME_CAPABILITY]), 'h2'),
    selectedPairing: { revision: 1, crossedRepair: true }
  })
  await expect(refused).resolves.toBe('not-sent')
  expect(runtimeCompatibilityChecks.get('env')).toBe(newer)
  await prober
  expect(hostCall).toHaveBeenCalledOnce()

  // An ordinary reader joining a read whose slot is replaced keeps its refresh policy: it reads
  // again. The generated one-selection rule is not imposed on it.
  hostCall.mockReset()
  clearRuntimeCompatibilityCache('env')
  const third = Promise.withResolvers<unknown>()
  hostCall.mockReturnValueOnce(third.promise)
  const first = getRuntimeEnvironmentCapabilityStatus('env')
  const reader = getRuntimeEnvironmentCapabilityStatus('env')
  rememberRuntimeEnvironmentCompatibility('env', compatibilityEntry())
  hostCall.mockResolvedValueOnce(answer(status('h5', [GENERATED_INPUT_RUNTIME_CAPABILITY]), 'h5'))
  third.resolve(answer(status('h4', [GENERATED_INPUT_RUNTIME_CAPABILITY]), 'h4'))
  await first
  await expect(reader).resolves.toMatchObject({ status: { runtimeId: 'h5' } })
  expect(hostCall).toHaveBeenCalledTimes(2)
})

// XR7: a cancellable call carries the accepted id to main through the subscription route too.
it('carries the accepted id on a cancellable paired call, never on its wire params', async () => {
  hostSubscribe.mockResolvedValue({ unsubscribe: vi.fn(), sendBinary: vi.fn() })
  rememberRuntimeEnvironmentCompatibility(
    'env',
    compatibilityEntry(status('h1', [GENERATED_INPUT_RUNTIME_CAPABILITY]) as never)
  )
  const abort = new AbortController()
  void callRuntimeRpc(
    { kind: 'environment', environmentId: 'env' },
    SEND,
    { text: 'x' },
    {
      signal: abort.signal,
      generatedInputOperationId: 'op-signal'
    }
  ).catch(() => {})
  await vi.waitFor(() => expect(hostSubscribe).toHaveBeenCalledOnce())
  expect(hostSubscribe.mock.calls[0][0]).toMatchObject({
    method: SEND,
    params: { text: 'x' },
    generatedInputOperationId: 'op-signal'
  })
  abort.abort()
})

function windowEvent() {
  const mainFrame = {}
  const sender = {
    id: 7,
    mainFrame,
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    send: vi.fn(),
    isDestroyed: () => false
  }
  return { sender, senderFrame: mainFrame }
}

const ORIGIN = 'desktop-window:7'
const partOf = (params: unknown) => (params as { part?: { final: boolean } } | undefined)?.part

/** The renderer's real generated client, through the real IPC handler, main ingress and routing,
 *  onto a paired host's real shared socket. One document of window 7; its record is accepted. */
async function pairedWindow(options: {
  capabilities: string[]
  delayedMethods?: string[]
  answer?: (params: unknown) => unknown
}) {
  const notices = new GeneratedAgentInputNotices()
  const status = {
    runtimeId: 'runtime-test',
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    minCompatibleMobileVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
    capabilities: [REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY, ...options.capabilities]
  }
  const server = await createSharedControlTestServer({
    delayedMethods: options.delayedMethods ?? [],
    resultForRequest: (method, params) =>
      method === 'status.get'
        ? status
        : (options.answer?.(params) ??
          (partOf(params)?.final === false
            ? { part: 'accepted' }
            : { delivery: { outcome: 'delivered' } }))
  })
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-generated-input-receipt-'))
  cleanups.push(() => rmSync(userDataPath, { recursive: true, force: true }))
  const { id: environmentId } = addEnvironmentFromPairingCode(userDataPath, {
    name: 'host',
    pairingCode: encodePairingOffer(server.offer)
  })
  cleanups.push(() => closeRemoteRuntimeSharedControlConnection(environmentId))
  h.handle.mockReset()
  const remote = registerRuntimeHandlers({
    generatedInputNotices: notices,
    cleanupSubscriptionsForConnection: vi.fn(),
    getRuntimeId: () => 'local-runtime'
  } as never)
  registerRuntimeEnvironmentPassiveHandlers(() => userDataPath, undefined, remote)
  registerRuntimeEnvironmentSubscriptionHandlers({
    getUserDataPath: () => userDataPath,
    remoteRuntimeSubscriptions: new Map(),
    pendingSubscriptions: new Map(),
    recordLayoutFrame: vi.fn(),
    acceptGeneratedInput: remote
  })
  const handler = channelHandlerLookup(h.handle)
  const call = handler('runtimeEnvironments:call')
  const document = windowEvent()
  const calls: {
    method: string
    expectedEnvironmentPairingRevision?: number
    generatedInputOperationId?: string
    generatedInputEnd?: number
  }[] = []
  // The window's cancellable calls: the real preload bridge onto main's subscription handlers.
  const ipcLog: { step: string; subscriptionId: string; method?: string }[] = []
  const listeners = new Set<(event: unknown, payload: never) => void>()
  document.sender.send.mockImplementation(
    (_channel: string, payload: { type: string; subscriptionId: string }) => {
      ipcLog.push({ step: `event:${payload.type}`, subscriptionId: payload.subscriptionId })
      for (const listener of listeners) {
        listener({}, payload as never)
      }
    }
  )
  const ipc = {
    invoke: (channel: string, args: { subscriptionId: string; method?: string }) => {
      ipcLog.push({ step: channel, subscriptionId: args.subscriptionId, method: args.method })
      return Promise.resolve(handler(channel)(document, args))
    },
    send: vi.fn(),
    on: (_channel: string, listener: (event: unknown, payload: never) => void) =>
      listeners.add(listener),
    removeListener: (_channel: string, listener: (event: unknown, payload: never) => void) =>
      listeners.delete(listener)
  }
  vi.stubGlobal('window', {
    setTimeout,
    clearTimeout,
    api: {
      runtimeEnvironments: {
        call: (args: (typeof calls)[number]) => {
          calls.push(args)
          return Promise.resolve(call(document, args))
        },
        subscribe: (
          args: (typeof calls)[number],
          callbacks: Parameters<typeof subscribeRuntimeEnvironmentFromPreload>[2]
        ) => {
          calls.push(args)
          return subscribeRuntimeEnvironmentFromPreload(ipc, args as never, callbacks)
        }
      }
    }
  })
  return {
    notices,
    server,
    calls,
    ipcLog,
    userDataPath,
    environmentId,
    target: { kind: 'environment' as const, environmentId },
    sends: (from = server) => from.requests.filter(({ method }) => method === SEND),
    certainty: (id: string) => notices.noticeOf(id)?.certainty ?? 'none',
    accept: (id: string, text: string) =>
      notices.upsert({
        id,
        text,
        agent: 'codex',
        certainty: 'not-sent',
        handle: '',
        worktreeId: '',
        ptyId: null,
        origin: ORIGIN,
        pending: true,
        connection: 'old-doc'
      })
  }
}

const request = (operationId: string, text: string) => ({
  text,
  submit: true,
  agent: 'codex' as const,
  retainNotice: true,
  operationId
})

// XR7: an older generated host keeps no notice by id and gets the request it always did; this
// window's runtime still follows the accepted request's own final frame, after a reload too.
it('follows an older generated host’s final frame by the local id, staging alone unsent', async () => {
  const w = await pairedWindow({
    capabilities: [GENERATED_INPUT_RUNTIME_CAPABILITY],
    delayedMethods: [SEND],
    answer: (params) =>
      partOf(params)?.final === false ? { part: 'accepted' } : { delivery: { outcome: 'not-sent' } }
  })
  const text = `${'x'.repeat(100_000)}exact\r\ntext 😀`
  w.accept('op-old', text)
  const sending = sendGeneratedTerminalInputToHandle(
    w.target,
    'host-terminal',
    request('op-old', text)
  )
  await vi.waitFor(() => expect(w.sends()).toHaveLength(1))
  // Only a part is staged on the host: a reload now shows it not sent.
  w.notices.revealPending(ORIGIN, 'new-doc')
  expect(w.certainty('op-old')).toBe('not-sent')
  w.server.flushDelayedResponses()
  await vi.waitFor(() => expect(w.sends()).toHaveLength(2))
  // The final, executable frame left: possibly sent from here, whoever reads it.
  expect(w.certainty('op-old')).toBe('unconfirmed')
  // The renderer that asked was replaced; the host's definite answer still settles the record.
  w.server.flushDelayedResponses()
  await expect(sending).resolves.toBe('not-sent')
  expect(w.certainty('op-old')).toBe('not-sent')
  // The old host's request is unchanged: its string address, no id, retain flag or window.
  for (const { params } of w.sends()) {
    expect(params).toMatchObject({ terminal: 'host-terminal', submit: true, agent: 'codex' })
    expect(params).not.toHaveProperty('operationId')
    expect(params).not.toHaveProperty('retainNotice')
    expect(params).not.toHaveProperty('window')
    expect(params).not.toHaveProperty('generatedInputOperationId')
  }
  expect(
    w
      .sends()
      .map(({ params }) =>
        typeof params === 'object' && params !== null && 'text' in params ? params.text : ''
      )
      .join('')
  ).toBe(text)
})

// XR11: a part before the last only stages text. An upload whose staged part's answer is lost
// ends there: nothing was sent, and a later report from the window cannot raise it.
it('proves an upload that stopped at a staged part unsent, past a late report', async () => {
  const w = await pairedWindow({
    capabilities: [GENERATED_INPUT_RUNTIME_CAPABILITY],
    delayedMethods: [SEND]
  })
  const text = 'y'.repeat(100_000)
  w.accept('op-stage', text)
  const seen: string[] = []
  w.notices.subscribe((change) => {
    if (change.kind === 'added' && change.notice.id === 'op-stage') {
      seen.push(change.notice.certainty)
    }
  })
  const sending = sendGeneratedTerminalInputToHandle(
    w.target,
    'host-terminal',
    request('op-stage', text)
  )
  await vi.waitFor(() => expect(w.sends()).toHaveLength(1))
  w.server.closeClients()
  await expect(sending).resolves.toBe('not-sent')
  expect(w.sends()).toHaveLength(1)
  expect(w.certainty('op-stage')).toBe('not-sent')
  // The window reports what it saw, possibly sent; main saw no executable frame.
  w.notices.upsert({
    id: 'op-stage',
    text,
    agent: 'codex',
    certainty: 'unconfirmed',
    handle: '',
    worktreeId: '',
    ptyId: null,
    origin: ORIGIN,
    reported: true
  })
  expect(w.certainty('op-stage')).toBe('not-sent')
  expect(seen).toEqual(['not-sent'])
})

// XR8: every call of a request goes over the pairing it was first selected on. Re-pairing after
// its first part refuses the rest before any frame; nothing reaches the new pairing, never resent.
it('holds every part to the first pairing, refusing the rest after a re-pair', async () => {
  const w = await pairedWindow({
    capabilities: [
      GENERATED_INPUT_RUNTIME_CAPABILITY,
      GENERATED_INPUT_REGISTER_RUNTIME_CAPABILITY,
      GENERATED_INPUT_FENCED_SEND_RUNTIME_CAPABILITY
    ],
    delayedMethods: [SEND]
  })
  const next = await createSharedControlTestServer()
  const first = resolveEnvironment(w.userDataPath, w.environmentId).pairingRevision!
  replaceRuntimeEnvironmentRevisions([
    { id: w.environmentId, createdAt: 1, pairingRevision: first }
  ])
  const text = 'z'.repeat(100_000)
  w.accept('op-pair', text)
  const sending = sendGeneratedTerminalInputToHandle(
    w.target,
    'host-terminal',
    request('op-pair', text)
  )
  await vi.waitFor(() => expect(w.sends()).toHaveLength(1))
  updateEnvironmentFromPairingCode(w.userDataPath, w.environmentId, {
    pairingCode: encodePairingOffer(next.offer)
  })
  // The renderer learns the new pairing too; the request it already selected does not.
  replaceRuntimeEnvironmentRevisions([
    { id: w.environmentId, createdAt: 1, pairingRevision: first + 1 }
  ])
  w.server.flushDelayedResponses()
  // Refused before its frame: main proves it unsent; the caller cannot know that and says maybe.
  await expect(sending).resolves.toBe('unconfirmed')
  expect(w.sends()).toHaveLength(1)
  expect(w.sends(next)).toHaveLength(0)
  expect(w.calls.filter(({ method }) => method === SEND)).toMatchObject([
    { expectedEnvironmentPairingRevision: first },
    { expectedEnvironmentPairingRevision: first }
  ])
  expect(w.notices.noticeOf('op-pair')).toMatchObject({ text, certainty: 'not-sent' })
  const [qualified] = w.sends()
  expect(qualified.params).toMatchObject({
    terminal: { handle: 'host-terminal', expectedRuntimeId: 'runtime-test' },
    operationId: 'op-pair'
  })
})

// C2: without a renderer revision, this request's own ordinary status call is its first
// resolution here. Re-pairing while that answer is held cannot move the request to the new pair.
it('pins a request with no renderer revision to the pairing its status call resolved', async () => {
  const w = await pairedWindow({
    capabilities: [GENERATED_INPUT_RUNTIME_CAPABILITY],
    delayedMethods: ['status.get']
  })
  const next = await createSharedControlTestServer()
  const first = resolveEnvironment(w.userDataPath, w.environmentId).pairingRevision!
  w.accept('op-status', 'exact')
  const sending = sendGeneratedTerminalInputToHandle(
    w.target,
    'host-terminal',
    request('op-status', 'exact')
  )
  await vi.waitFor(() =>
    expect(w.server.requests.filter(({ method }) => method === 'status.get')).toHaveLength(1)
  )
  updateEnvironmentFromPairingCode(w.userDataPath, w.environmentId, {
    pairingCode: encodePairingOffer(next.offer)
  })
  w.server.flushDelayedResponses()
  await expect(sending).resolves.toBe('unconfirmed')
  expect(w.sends()).toHaveLength(0)
  expect(w.sends(next)).toHaveLength(0)
  // One ordinary status call, no probe of its own for the receipt, and no resend.
  expect(w.calls.map(({ method }) => method)).toEqual(['status.get', SEND])
  expect(w.notices.noticeOf('op-status')).toMatchObject({ text: 'exact', certainty: 'not-sent' })
  expect(
    w.notices.pinRoute('op-status', ORIGIN, {
      environmentId: w.environmentId,
      pairingRevision: first + 1
    })
  ).toBe(first)
})

// XR12: an operation that joins another reader's ordinary status goes over the pairing main
// selected for that status, under its own id. Re-pairing while the status is held cannot move it.
it('holds requests that joined another reader’s status to the pairing that status selected', async () => {
  const w = await pairedWindow({
    capabilities: [GENERATED_INPUT_RUNTIME_CAPABILITY],
    delayedMethods: ['status.get']
  })
  const next = await createSharedControlTestServer()
  const first = resolveEnvironment(w.userDataPath, w.environmentId).pairingRevision!
  // An unrelated read, with no operation of its own, selects pair 1; its answer is held.
  const ordinary = getRuntimeEnvironmentCapabilityStatus(w.environmentId)
  await vi.waitFor(() =>
    expect(w.server.requests.filter(({ method }) => method === 'status.get')).toHaveLength(1)
  )
  w.accept('op-coalesced', 'exact-coalesced')
  w.accept('op-joined', 'exact-joined')
  const sending = Promise.all([
    sendGeneratedTerminalInputToHandle(
      w.target,
      'host-terminal',
      request('op-coalesced', 'exact-coalesced')
    ),
    sendGeneratedTerminalInputToHandle(
      w.target,
      'host-terminal',
      request('op-joined', 'exact-joined')
    )
  ])
  updateEnvironmentFromPairingCode(w.userDataPath, w.environmentId, {
    pairingCode: encodePairingOffer(next.offer)
  })
  w.server.flushDelayedResponses()
  await ordinary
  // Refused before any frame; main proves them unsent, the callers cannot know and say maybe.
  await expect(sending).resolves.toEqual(['unconfirmed', 'unconfirmed'])
  expect(w.sends()).toHaveLength(0)
  expect(w.sends(next)).toHaveLength(0)
  // The one ordinary status, no probe of their own; each request names only itself.
  expect(w.calls.filter(({ method }) => method === 'status.get')).toHaveLength(1)
  expect(
    w.calls
      .filter(({ method }) => method === SEND)
      .map(({ generatedInputOperationId, expectedEnvironmentPairingRevision }) => ({
        generatedInputOperationId,
        expectedEnvironmentPairingRevision
      }))
  ).toEqual([
    { generatedInputOperationId: 'op-coalesced', expectedEnvironmentPairingRevision: first },
    { generatedInputOperationId: 'op-joined', expectedEnvironmentPairingRevision: first }
  ])
  expect(w.notices.noticeOf('op-coalesced')).toMatchObject({
    text: 'exact-coalesced',
    certainty: 'not-sent'
  })
  expect(w.notices.noticeOf('op-joined')).toMatchObject({
    text: 'exact-joined',
    certainty: 'not-sent'
  })
})

// XR12, cached form: an ordinary compatibility check's settled entry keeps the pairing main
// selected for it, so a request routed by it after a re-pair is refused before any frame.
it('routes by a cached compatibility answer only over the pairing it was selected on', async () => {
  const w = await pairedWindow({ capabilities: [GENERATED_INPUT_RUNTIME_CAPABILITY] })
  const next = await createSharedControlTestServer()
  const first = resolveEnvironment(w.userDataPath, w.environmentId).pairingRevision!
  await ensureRuntimeEnvironmentCompatible(w.environmentId)
  updateEnvironmentFromPairingCode(w.userDataPath, w.environmentId, {
    pairingCode: encodePairingOffer(next.offer)
  })
  w.accept('op-cached', 'exact-cached')
  await expect(
    sendGeneratedTerminalInputToHandle(
      w.target,
      'host-terminal',
      request('op-cached', 'exact-cached')
    )
  ).resolves.toBe('unconfirmed')
  expect(w.sends()).toHaveLength(0)
  expect(w.sends(next)).toHaveLength(0)
  expect(w.calls.map(({ method }) => method)).toEqual(['status.get', SEND])
  expect(w.calls[1]).toMatchObject({
    generatedInputOperationId: 'op-cached',
    expectedEnvironmentPairingRevision: first
  })
  expect(w.notices.noticeOf('op-cached')).toMatchObject({ certainty: 'not-sent' })
})

// XR14: a request that joined another reader's pending status keeps that selection when a
// publication replaces the reusable cache slot before it answers: no second status for it, and
// it goes over the pairing that status was selected on.
it('keeps a joined status selection across a publication that replaces its cache slot', async () => {
  const w = await pairedWindow({
    capabilities: [GENERATED_INPUT_RUNTIME_CAPABILITY],
    delayedMethods: ['status.get']
  })
  const successor = {
    runtimeId: 'runtime-test',
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    minCompatibleMobileVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
    capabilities: [REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY, GENERATED_INPUT_RUNTIME_CAPABILITY]
  }
  const next = await createSharedControlTestServer({
    resultForRequest: (method) =>
      method === 'status.get' ? successor : { delivery: { outcome: 'delivered' } }
  })
  const first = resolveEnvironment(w.userDataPath, w.environmentId).pairingRevision!
  const ordinary = getRuntimeEnvironmentCapabilityStatus(w.environmentId)
  await vi.waitFor(() =>
    expect(w.server.requests.filter(({ method }) => method === 'status.get')).toHaveLength(1)
  )
  w.accept('op-publication', 'exact-publication')
  const sending = sendGeneratedTerminalInputToHandle(
    w.target,
    'host-terminal',
    request('op-publication', 'exact-publication')
  )
  updateEnvironmentFromPairingCode(w.userDataPath, w.environmentId, {
    pairingCode: encodePairingOffer(next.offer)
  })
  // The reachable successor's status, published through the cache's own entry point.
  clearRecentRuntimeCompatibilityFailure(w.environmentId, {
    status: successor as never,
    snapshot: {
      pairingRevision: resolveEnvironment(w.userDataPath, w.environmentId).pairingRevision!
    }
  })
  w.server.flushDelayedResponses()
  await ordinary
  await expect(sending).resolves.toBe('unconfirmed')
  expect(w.sends()).toHaveLength(0)
  expect(w.sends(next)).toHaveLength(0)
  expect(w.calls.map(({ method }) => method)).toEqual(['status.get', SEND])
  expect(w.calls[1]).toMatchObject({
    generatedInputOperationId: 'op-publication',
    expectedEnvironmentPairingRevision: first
  })
  expect(w.notices.noticeOf('op-publication')).toMatchObject({
    text: 'exact-publication',
    certainty: 'not-sent'
  })
})

// CV3: an older host with no generated operation, driven by a caller whose cancellation stays
// live and is never used. The actual legacy source and writer send each frame as a cancellable
// call through main's subscription route onto the real paired socket, and the host acknowledges.
it('delivers a live-cancellable request to an older host over the cancellable route', async () => {
  const w = await pairedWindow({
    capabilities: [],
    // An older host: its process unknown, only streamed text, every write acknowledged.
    answer: (params) => {
      const { text, screen } = params as { text?: string; screen?: true }
      return text !== undefined
        ? { send: { accepted: true, bytesWritten: text.length } }
        : screen
          ? { terminal: { tail: [], source: 'stream' } }
          : { process: { foregroundProcess: null, verdict: 'unverifiable' } }
    }
  })
  const live = new AbortController()
  w.accept('op-live', 'exact live prompt')
  const outcome = await deliverGeneratedPaste({
    ptyId: toRemoteRuntimePtyId('host-terminal', w.environmentId),
    content: 'exact live prompt',
    submit: true,
    agent: 'claude',
    inputKind: 'driving',
    intent: 'running',
    deadline: Date.now() + 20_000,
    signal: live.signal,
    operationId: 'op-live'
  })
  expect(outcome).toBe('delivered')
  expect(live.signal.aborted).toBe(false)
  const frames = w.server.requests.filter(({ method }) => method === 'terminal.send')
  expect(frames.map(({ params }) => (params as { text: string }).text)).toEqual([
    '\u001b[200~exact live prompt\u001b[201~',
    '\r'
  ])
  // The old host's wire is what it always was: no id, end or generated field.
  for (const { params } of frames) {
    expect(Object.keys(params as object).sort()).toEqual(['client', 'terminal', 'text'])
  }
  // One selection, and every frame fixed to its pairing; the local metadata stays local.
  expect(w.calls.filter(({ method }) => method === 'status.get')).toHaveLength(1)
  const writes = w.calls.filter(({ method }) => method === 'terminal.send')
  expect(writes).toHaveLength(2)
  for (const write of writes) {
    expect(write).toMatchObject({
      expectedEnvironmentPairingRevision: resolveEnvironment(w.userDataPath, w.environmentId)
        .pairingRevision,
      generatedInputOperationId: 'op-live',
      generatedInputEnd: expect.any(Number)
    })
  }
  // Each frame's subscription closes only after the host's answer arrived.
  const sent = w.ipcLog.filter(({ method }) => method === 'terminal.send')
  expect(sent).toHaveLength(2)
  for (const { subscriptionId } of sent) {
    const steps = w.ipcLog
      .filter((entry) => entry.subscriptionId === subscriptionId)
      .map(({ step }) => step)
    expect(steps.slice(0, 3)).toEqual([
      'runtimeEnvironments:subscribe',
      'event:response',
      'runtimeEnvironments:unsubscribe'
    ])
  }
})
