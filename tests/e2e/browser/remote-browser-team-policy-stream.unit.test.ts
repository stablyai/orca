// A person's paired desktop or web stream viewer, driven through the host's real RPC dispatcher and
// team Browser Use policy: viewing stays open to people, while agent callers stay refused.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as HostMachine from '../../../src/main/runtime/hosts/platform-probe/runtime-host-machine'
import type * as ServerUpdater from '../../../src/main/runtime/hosts/management/remote-server-updater'

vi.mock('electron', () => ({
  app: { getPath: () => '/synthetic', on: () => {}, isPackaged: false },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  ipcMain: { handle: () => {}, removeHandler: () => {}, on: () => {} },
  session: { fromPartition: () => ({}) },
  webContents: { fromId: () => null, getAllWebContents: () => [] }
}))
vi.mock(
  '../../../src/main/runtime/hosts/platform-probe/runtime-host-machine',
  async (importOriginal) => ({
    ...(await importOriginal<typeof HostMachine>()),
    readHostMachineWithin: async () => null
  })
)
vi.mock(
  '../../../src/main/runtime/hosts/management/remote-server-updater',
  async (importOriginal) => ({
    ...(await importOriginal<typeof ServerUpdater>()),
    getRemoteServerUpdaterSnapshot: () => ({ appVersion: '0.0.0-test', support: null })
  })
)

import { RpcDispatcher } from '../../../src/main/runtime/rpc/dispatcher'
import type { RpcDispatchStreamingOptions } from '../../../src/main/runtime/rpc/dispatch/dispatcher-stream-options'
import type { RpcResponse } from '../../../src/main/runtime/rpc/core'
import { BROWSER_CORE_METHODS } from '../../../src/main/runtime/rpc/methods/browser/browser-core'
import { BROWSER_SCREENCAST_METHODS } from '../../../src/main/runtime/rpc/methods/browser/browser-screencast'
import { STATUS_METHODS } from '../../../src/main/runtime/rpc/methods/host-management/status'
import { LOCAL_CLI_RPC_CALLER } from '../../../src/main/runtime/rpc/callers/rpc-caller-identity'
import type { OrcaRuntimeService } from '../../../src/main/runtime/orca-runtime'
import { BrowserError } from '../../../src/main/browser/browser-error'
import {
  initializeActiveTeamProfile,
  observeActiveTeamSession
} from '../../../src/main/orca-profiles/cloud-auth/active-team-capabilities'
import { createDefaultLocalOrcaProfile } from '../../../src/shared/orca-profiles/orca-profiles'
import { ORCA_CLOUD_TEAM_POLICY_FLAGS } from '../../../src/shared/orca-profiles/orca-cloud-team-policy'
import { CLI_AGENT_CALLER_CLIENT_CAPABILITY } from '../../../src/shared/remote-runtime/cli-agent-caller-capability'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../src/shared/remote-runtime/protocol/electron-remote-runtime-client-capabilities'
import { WEB_RUNTIME_CLIENT_CAPABILITIES } from '../../../src/shared/remote-runtime/protocol/web-runtime-client-capabilities'
import { BROWSER_SCREENCAST_RUNTIME_CAPABILITY } from '../../../src/shared/browser/runtime/browser-runtime-capabilities'
import {
  beforeDeadline,
  DEADLINE_PASSED,
  monotonicNow
} from '../../../src/shared/concurrency/deadline-settle-notifier'
import type { RuntimeRpcResponse } from '../../../src/shared/remote-runtime/rpc/runtime-rpc-envelope'
import { createHarness } from '../../../src/renderer/src/components/browser-pane/stream-remote/remote-browser-stream-lifecycle-test-harness'
import type { RemoteBrowserRpcCall } from '../../../src/renderer/src/components/browser-pane/stream-remote/remote-browser-page-session'
import type { RemoteBrowserScreencastSubscribe } from '../../../src/renderer/src/components/browser-pane/stream-remote/remote-browser-screencast-subscription'
import {
  remoteBrowserStreamUnreachableNotice,
  remoteBrowserStreamUnsupportedNotice
} from '../../../src/renderer/src/components/browser-pane/stream-remote/remote-browser-stream-status'

type Transport = Pick<
  RpcDispatchStreamingOptions,
  'caller' | 'clientKind' | 'pairedDeviceId' | 'clientCapabilities' | 'callerScope'
>

const PAIRED_DESKTOP: Transport = {
  pairedDeviceId: 'device-desktop',
  clientKind: 'runtime',
  clientCapabilities: [...ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES]
}
const WEB_CLIENT: Transport = {
  pairedDeviceId: 'device-web',
  clientKind: 'runtime',
  clientCapabilities: [...WEB_RUNTIME_CLIENT_CAPABILITIES]
}
const AGENT_ON_PAIRING: Transport = {
  ...PAIRED_DESKTOP,
  clientCapabilities: [
    ...ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
    CLI_AGENT_CALLER_CLIENT_CAPABILITY
  ]
}
const LOCAL_CLI: Transport = { caller: LOCAL_CLI_RPC_CALLER }
// No declared client and no device: the runtime socket's default, the local orca CLI.
const UNDECLARED_LOCAL: Transport = {}
const SAVED_PAGE = 'host-saved-page'

const TEAM_ROOT = '/orca-browser-stream-policy-test'
function setTeamBrowserUse(allowed: boolean | undefined): void {
  const cloud = {
    userId: 'user_fixture',
    cloudProfileId: 'cloud_fixture',
    email: 'member@example.test',
    linkedAt: 1,
    activeOrgId: 'org_fixture'
  }
  const finish = initializeActiveTeamProfile(TEAM_ROOT, {
    ...createDefaultLocalOrcaProfile(1),
    cloud
  })
  finish({
    accessToken: 'access-fixture',
    refreshToken: 'refresh-fixture',
    expiresAt: 2,
    identity: cloud,
    capabilities: {
      flags: {
        team_settings: true,
        ...(allowed === undefined ? {} : { [ORCA_CLOUD_TEAM_POLICY_FLAGS.browserUse]: allowed })
      },
      teamPolicy: { orgIds: ['org_fixture'] },
      refreshedAt: 1
    }
  })
}

/** A seeded host: the runtime calls each browser method reaches, with no real browser behind it. */
function createHost(options: { advertiseScreencast?: boolean; tabShowError?: Error } = {}) {
  const pages = new Set<string>([SAVED_PAGE])
  const reached = { tabShow: 0, tabCreate: 0, screencast: 0 }
  const streams = { ended: 0 }
  let created = 0
  const describe = (page: string) => ({
    browserPageId: page,
    index: 0,
    url: 'https://example.test/',
    title: 'Example',
    active: true,
    loadError: null,
    certificateFailure: null
  })
  const runtime = {
    getRuntimeId: () => 'runtime-fixture',
    getStartedAt: () => 1,
    recordFeatureInteraction: () => {},
    registerSubscriptionCleanup: () => {},
    machineNameReady: async () => {},
    getStatus: () => ({
      runtimeId: 'runtime-fixture',
      capabilities:
        options.advertiseScreencast === false ? [] : [BROWSER_SCREENCAST_RUNTIME_CAPABILITY]
    }),
    browserTabShow: async ({ page }: { page: string }) => {
      reached.tabShow += 1
      if (options.tabShowError) {
        throw options.tabShowError
      }
      if (!pages.has(page)) {
        throw new BrowserError('browser_tab_not_found', `Browser page ${page} was not found`)
      }
      return { tab: describe(page) }
    },
    browserTabCreate: async () => {
      reached.tabCreate += 1
      const browserPageId = `host-created-${++created}`
      pages.add(browserPageId)
      return { browserPageId }
    },
    browserTabClose: async () => ({ closed: true }),
    browserScreencast: async (
      params: { page: string },
      context: { emit: (event: unknown) => void; signal?: AbortSignal }
    ) => {
      reached.screencast += 1
      // Ready before the viewer's subscribe call has returned, as a fast host does.
      context.emit({
        type: 'ready',
        subscriptionId: 'subscription-fixture',
        browserPageId: params.page,
        format: 'jpeg',
        tab: { url: 'https://example.test/', title: 'Example' }
      })
      await new Promise<void>((resolve) => {
        if (!context.signal || context.signal.aborted) {
          resolve()
          return
        }
        context.signal.addEventListener('abort', () => resolve(), { once: true })
      })
      streams.ended += 1
    }
  }
  const viewerMethods = new Set(['browser.tabShow', 'browser.tabCreate', 'browser.tabClose'])
  const dispatcher = new RpcDispatcher({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the status, tab and screencast handlers read only the runtime members above.
    runtime: runtime as unknown as OrcaRuntimeService,
    methods: [
      ...STATUS_METHODS,
      ...BROWSER_CORE_METHODS.filter((method) => viewerMethods.has(method.name)),
      ...BROWSER_SCREENCAST_METHODS
    ]
  })
  return { dispatcher, reached, streams, pages }
}

type Host = ReturnType<typeof createHost>
type Failure = { method: string; code: string }
const OUTCOME_WAIT = { timeout: 2_000, interval: 10 }
const openStreams: Promise<void>[] = []
const closers = new Set<() => void>()

async function waitForStreamDispatch<T>(dispatch: Promise<T>, operation: string): Promise<T> {
  const result = await beforeDeadline(dispatch, monotonicNow() + OUTCOME_WAIT.timeout)
  if (result === DEADLINE_PASSED) {
    throw new Error(`Timed out after ${OUTCOME_WAIT.timeout} ms waiting for ${operation} to settle`)
  }
  return result
}

/** The viewer's two host seams, carried over the real dispatcher with one transport's identity. */
function connectViewer(host: Host, transport: Transport) {
  const failures: Failure[] = []
  const order = { readyBeforeSubscribeReturned: false }
  let requests = 0
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each method's result is the reply shape its viewer caller reads.
  const callRpc = (async (_target: unknown, method: string, params?: unknown) => {
    const response: RpcResponse = await host.dispatcher.dispatch(
      { id: `call-${++requests}`, authToken: 'fixture', method, params },
      transport
    )
    if (response.ok === false) {
      failures.push({ method, code: response.error.code })
      throw Object.assign(new Error(response.error.message), { code: response.error.code })
    }
    return response.result
  }) as unknown as RemoteBrowserRpcCall
  const subscribeScreencast: RemoteBrowserScreencastSubscribe = async (args, callbacks) => {
    const controller = new AbortController()
    let returned = false
    // Not awaited: the stream lives until unsubscribe aborts it.
    const stream = host.dispatcher.dispatchStreamingObjects(
      {
        id: `stream-${++requests}`,
        authToken: 'fixture',
        method: args.method,
        params: args.params
      },
      (envelope) => {
        if (controller.signal.aborted) {
          return
        }
        if (envelope.ok === false) {
          failures.push({ method: args.method, code: envelope.error.code })
        } else if (!returned) {
          order.readyBeforeSubscribeReturned = true
        }
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatcher's envelope is the wire envelope the viewer reads.
        callbacks.onResponse(envelope as unknown as RuntimeRpcResponse<unknown>)
      },
      { ...transport, signal: controller.signal }
    )
    void stream.catch(() => {}) // Teardown asserts the dispatch settled successfully.
    openStreams.push(stream)
    returned = true
    return { unsubscribe: () => controller.abort() }
  }
  const harness = createHarness({ callRpc, subscribeScreencast })
  return { harness, failures, order }
}

async function openViewer(
  viewer: ReturnType<typeof connectViewer>,
  assertOutcome: () => void = () => expect(viewer.harness.currentStatusKind).toBe('live')
): Promise<() => void> {
  const teardown = viewer.harness.lifecycle.open()
  const close = () => {
    closers.delete(close)
    teardown()
  }
  closers.add(close)
  await vi.waitFor(assertOutcome, OUTCOME_WAIT)
  return close
}

afterEach(async () => {
  const errors: unknown[] = []
  try {
    for (const close of closers) {
      try {
        close()
      } catch (error) {
        errors.push(error)
      }
    }
    // Record failures before the drain finishes so a hung stream cannot hide them.
    const drains = openStreams.splice(0).map((stream) =>
      stream.catch((error: unknown) => {
        errors.push(error)
      })
    )
    await waitForStreamDispatch(Promise.all(drains), 'viewer screencast dispatches after teardown')
  } catch (error) {
    errors.push(error)
  } finally {
    const profile = createDefaultLocalOrcaProfile(1)
    initializeActiveTeamProfile(TEAM_ROOT, profile)(undefined)
    observeActiveTeamSession(TEAM_ROOT, profile.id, undefined)
  }
  if (errors.length === 1) {
    throw errors[0]
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Viewer screencast cleanup failed')
  }
})

describe('stream viewer with team Browser Use off', () => {
  it.each([
    ['paired desktop', PAIRED_DESKTOP],
    ['web client', WEB_CLIENT]
  ])('streams a fresh tab on the %s', async (_name, transport) => {
    setTeamBrowserUse(false)
    const host = createHost()
    const viewer = connectViewer(host, transport)
    await openViewer(viewer)
    expect(viewer.harness.currentError).toBeNull()
    expect(viewer.failures).toEqual([])
    expect(viewer.harness.storedHandle?.remotePageId).toMatch(/^host-created-/)
    expect(host.reached.screencast).toBe(1)
  })

  it.each([
    ['paired desktop', PAIRED_DESKTOP],
    ['web client', WEB_CLIENT]
  ])('streams a saved tab on the %s', async (_name, transport) => {
    setTeamBrowserUse(false)
    const host = createHost()
    const viewer = connectViewer(host, transport)
    viewer.harness.seedStoredHandle({ environmentId: 'env-1', remotePageId: SAVED_PAGE })
    await openViewer(viewer)
    expect(viewer.harness.storedHandle).toEqual({
      environmentId: 'env-1',
      remotePageId: SAVED_PAGE
    })
    expect(host.reached.tabCreate).toBe(0)
    expect(viewer.failures).toEqual([])
  })

  it.each([
    ['an agent on a pairing', AGENT_ON_PAIRING],
    ['the local CLI', LOCAL_CLI],
    ['an undeclared local client', UNDECLARED_LOCAL]
  ])('refuses %s before any browser handler runs', async (_name, transport) => {
    setTeamBrowserUse(false)
    const fresh = createHost()
    const freshViewer = connectViewer(fresh, transport)
    await openViewer(freshViewer, () =>
      expect(freshViewer.harness.currentStatusKind).toBe('stopped')
    )
    expect(freshViewer.failures).toContainEqual({
      method: 'browser.tabCreate',
      code: 'browser_use_disabled'
    })
    expect(freshViewer.harness.currentError).toBe(remoteBrowserStreamUnreachableNotice())
    expect(fresh.reached).toEqual({ tabShow: 0, tabCreate: 0, screencast: 0 })

    const saved = createHost()
    const savedViewer = connectViewer(saved, transport)
    savedViewer.harness.seedStoredHandle({ environmentId: 'env-1', remotePageId: SAVED_PAGE })
    await openViewer(savedViewer, () =>
      expect(savedViewer.harness.currentStatusKind).toBe('stopped')
    )
    expect(savedViewer.failures).toContainEqual({
      method: 'browser.tabShow',
      code: 'browser_use_disabled'
    })
    expect(savedViewer.harness.currentError).toBe(remoteBrowserStreamUnreachableNotice())
    // A refusal is not a missing page: the saved tab is kept, not closed.
    expect(savedViewer.harness.storedHandle?.remotePageId).toBe(SAVED_PAGE)
    expect(savedViewer.harness.closedPages).toEqual([])
    expect(saved.reached).toEqual({ tabShow: 0, tabCreate: 0, screencast: 0 })
  })

  it('goes live when the host says ready before the subscribe returns', async () => {
    setTeamBrowserUse(false)
    const host = createHost()
    const viewer = connectViewer(host, PAIRED_DESKTOP)
    await openViewer(viewer)
    expect(viewer.order.readyBeforeSubscribeReturned).toBe(true)
  })

  it("ends the host's stream when the pane's open teardown runs", async () => {
    setTeamBrowserUse(false)
    const host = createHost()
    const viewer = connectViewer(host, WEB_CLIENT)
    const close = await openViewer(viewer)
    expect(host.streams.ended).toBe(0)
    close()
    await vi.waitFor(() => expect(host.streams.ended).toBe(1), OUTCOME_WAIT)
  })

  it('treats a declared client with no identity as a person, as before', async () => {
    setTeamBrowserUse(false)
    const host = createHost()
    const viewer = connectViewer(host, { clientKind: 'runtime' })
    await openViewer(viewer)
  })

  it('closes a saved tab whose page the host no longer has, without making a new one', async () => {
    setTeamBrowserUse(false)
    const host = createHost()
    const viewer = connectViewer(host, PAIRED_DESKTOP)
    viewer.harness.seedStoredHandle({ environmentId: 'env-1', remotePageId: 'host-gone-page' })
    await openViewer(viewer, () => expect(viewer.harness.closedPages).toContain('host-gone-page'))
    expect(viewer.failures).toContainEqual({
      method: 'browser.tabShow',
      code: 'browser_tab_not_found'
    })
    expect(viewer.harness.storedHandle).toBeNull()
    expect(host.reached.tabCreate).toBe(0)
    expect(host.reached.screencast).toBe(0)
    expect(viewer.harness.currentStatusKind).not.toBe('live')
  })

  it('keeps a saved tab and shows the stopped notice when the host fails another way', async () => {
    setTeamBrowserUse(false)
    const host = createHost({
      tabShowError: new BrowserError('browser_navigation_failed', 'The page could not load.')
    })
    const viewer = connectViewer(host, PAIRED_DESKTOP)
    viewer.harness.seedStoredHandle({ environmentId: 'env-1', remotePageId: SAVED_PAGE })
    await openViewer(viewer, () => expect(viewer.harness.currentStatusKind).toBe('stopped'))
    expect(viewer.failures).toContainEqual({
      method: 'browser.tabShow',
      code: 'browser_navigation_failed'
    })
    expect(viewer.harness.currentError).toBe(remoteBrowserStreamUnreachableNotice())
    expect(viewer.harness.storedHandle?.remotePageId).toBe(SAVED_PAGE)
    expect(viewer.harness.closedPages).toEqual([])
    expect(host.reached.tabCreate).toBe(0)
  })

  it('shows the unsupported notice when the host does not advertise streaming', async () => {
    setTeamBrowserUse(false)
    const host = createHost({ advertiseScreencast: false })
    const viewer = connectViewer(host, PAIRED_DESKTOP)
    await openViewer(viewer, () => expect(viewer.harness.currentStatusKind).toBe('stopped'))
    expect(viewer.harness.currentError).toBe(remoteBrowserStreamUnsupportedNotice())
    expect(host.reached.screencast).toBe(0)
  })
})

describe('host dispatcher seam with team Browser Use off', () => {
  const screencastRequest = {
    id: 'stream-direct',
    authToken: 'fixture',
    method: 'browser.screencast',
    params: { worktree: 'worktree:wt-1', page: SAVED_PAGE, format: 'jpeg' }
  }

  it('streams to a person and refuses an agent on the same streaming path', async () => {
    setTeamBrowserUse(false)
    const host = createHost()
    const person = new AbortController()
    const personEnvelopes: RpcResponse[] = []
    const personStream = host.dispatcher.dispatchStreamingObjects(
      screencastRequest,
      (envelope) => personEnvelopes.push(envelope),
      { ...WEB_CLIENT, signal: person.signal }
    )
    try {
      await vi.waitFor(
        () => expect(personEnvelopes[0]).toMatchObject({ ok: true, result: { type: 'ready' } }),
        OUTCOME_WAIT
      )
    } finally {
      person.abort()
      await expect(
        waitForStreamDispatch(personStream, 'paired web screencast dispatch after abort')
      ).resolves.toBeUndefined()
    }

    const agentEnvelopes: RpcResponse[] = []
    await host.dispatcher.dispatchStreamingObjects(
      screencastRequest,
      (envelope) => agentEnvelopes.push(envelope),
      AGENT_ON_PAIRING
    )
    expect(agentEnvelopes).toEqual([
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'browser_use_disabled' })
      })
    ])
    expect(host.reached.screencast).toBe(1)
  })

  it('keeps tab details off the phone allowlist while the phone still streams', async () => {
    setTeamBrowserUse(false)
    const host = createHost()
    const phone: Transport = {
      pairedDeviceId: 'device-phone',
      clientKind: 'mobile',
      callerScope: { kind: 'mobile' }
    }
    const shown = await host.dispatcher.dispatch(
      {
        id: 'phone-tab-show',
        authToken: 'fixture',
        method: 'browser.tabShow',
        params: { page: SAVED_PAGE }
      },
      phone
    )
    expect(shown).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(host.reached.tabShow).toBe(0)
    const status = await host.dispatcher.dispatch(
      { id: 'phone-status', authToken: 'fixture', method: 'status.get' },
      phone
    )
    expect(status.ok).toBe(true)
    const envelopes: RpcResponse[] = []
    const controller = new AbortController()
    const stream = host.dispatcher.dispatchStreamingObjects(
      screencastRequest,
      (envelope) => envelopes.push(envelope),
      { ...phone, signal: controller.signal }
    )
    try {
      await vi.waitFor(
        () => expect(envelopes[0]).toMatchObject({ ok: true, result: { type: 'ready' } }),
        OUTCOME_WAIT
      )
    } finally {
      controller.abort()
      await waitForStreamDispatch(stream, 'mobile screencast dispatch after abort')
    }
  })

  it('refuses a request without a page before the handler runs', async () => {
    setTeamBrowserUse(false)
    const host = createHost()
    const response = await host.dispatcher.dispatch(
      { id: 'no-page', authToken: 'fixture', method: 'browser.tabShow', params: {} },
      PAIRED_DESKTOP
    )
    expect(response.ok).toBe(false)
    expect(response.ok === false && response.error.code).not.toBe('browser_use_disabled')
    expect(host.reached.tabShow).toBe(0)
  })
})

describe('stream viewer when the team allows Browser Use', () => {
  it.each([
    ['allowed', true],
    ['unset', undefined]
  ])('lets agent transports through when the policy is %s', async (_name, allowed) => {
    setTeamBrowserUse(allowed)
    for (const transport of [AGENT_ON_PAIRING, LOCAL_CLI]) {
      const host = createHost()
      const viewer = connectViewer(host, transport)
      await openViewer(viewer)
      expect(viewer.failures).toEqual([])
    }
  })
})
