import { readFileSync } from 'node:fs'
import process from 'node:process'
import { randomUUID } from 'node:crypto'
import { DaemonPtyAdapter } from '../../../src/main/daemon/daemon-pty-adapter'
import type { DaemonPtyRouter } from '../../../src/main/daemon/daemon-pty-router'
import { OrcaRuntimeService } from '../../../src/main/runtime/orca-runtime'
import { RpcDispatcher } from '../../../src/main/runtime/rpc/dispatcher'
import { SESSION_TAB_METHODS } from '../../../src/main/runtime/rpc/methods/session-tabs'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../src/shared/runtime-types'
import { createDesktopDiscoveredDaemonRouter } from './daemon-generation-desktop-discovery'
import { dispatchFixtureCloseBursts } from './daemon-generation-runtime-close'
import { DAEMON_GENERATION_WORKTREE_ID } from './daemon-generation-fixture-contract'

type ClientGeneration = {
  protocolVersion: number
  socketPath: string
  tokenPath: string
}

type ClientSession = {
  protocolVersion: number
  sessionId: string
  rootPid: number
  label: string
  role: 'live' | 'stale-mirror'
}

type ClientConfig = {
  generations: ClientGeneration[]
  currentProtocolVersion: number
  daemonDir: string
  historyDir: string
  sessions: ClientSession[]
  reconnectBursts: number
  cwd: string
}

const WORKTREE_ID = DAEMON_GENERATION_WORKTREE_ID
const PARENT_TAB_ID = 'remote-reconnect-tab'
const MAX_OUTPUT_CHARS = 32_768

function readConfig(): ClientConfig {
  const configIndex = process.argv.indexOf('--config')
  const configPath = configIndex >= 0 ? process.argv[configIndex + 1] : undefined
  if (!configPath) {
    throw new Error('Reconnect client requires --config <path>')
  }
  return JSON.parse(readFileSync(configPath, 'utf8')) as ClientConfig
}

async function waitFor(description: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() <= deadline) {
    if (predicate()) {
      return
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

function createDirectAdapters(
  generations: readonly ClientGeneration[]
): Map<number, DaemonPtyAdapter> {
  return new Map(
    generations.map((generation) => [
      generation.protocolVersion,
      new DaemonPtyAdapter({
        socketPath: generation.socketPath,
        tokenPath: generation.tokenPath,
        protocolVersion: generation.protocolVersion
      })
    ])
  )
}

async function connectThroughDesktopDiscovery(
  config: ClientConfig,
  burst: number
): Promise<DaemonPtyRouter> {
  const { router, adapters } = await createDesktopDiscoveredDaemonRouter(config)
  const outputBySessionId = new Map<string, string>()
  for (const adapter of adapters) {
    const protocolVersion = adapter.protocolVersion
    adapter.onData((event) => {
      const session = config.sessions.find(
        (candidate) =>
          candidate.protocolVersion === protocolVersion && candidate.sessionId === event.id
      )
      if (session) {
        outputBySessionId.set(
          event.id,
          `${outputBySessionId.get(event.id) ?? ''}${event.data}`.slice(-MAX_OUTPUT_CHARS)
        )
      }
    })
  }

  await router.getCurrentAdapter().listProcesses()
  await router.discoverLegacySessions()
  for (const session of config.sessions) {
    const attached = await router.spawn({
      sessionId: session.sessionId,
      isNewSession: false,
      cols: 100,
      rows: 30,
      cwd: config.cwd
    })
    if (!attached.isReattach || attached.pid !== session.rootPid) {
      throw new Error(`Reconnect changed ${session.label} process incarnation`)
    }
    const nonce = `reconnect-${burst}-${randomUUID().slice(0, 8)}`
    router.write(session.sessionId, `PING ${session.label} ${nonce}\r`)
    await waitFor(`${session.label} reconnect reply`, () =>
      (outputBySessionId.get(session.sessionId) ?? '').includes(
        `ORCA_GENERATION_CANARY_ACK ${session.label} ${nonce}`
      )
    )
  }
  return router
}

async function connectParallelRuntimeClients(config: ClientConfig): Promise<void> {
  const clients = [...createDirectAdapters(config.generations).values()]
  try {
    const lists = await Promise.all(clients.map((client) => client.listProcesses()))
    if (!lists.every((sessions) => sessions.length === 2)) {
      throw new Error('Parallel runtime client did not see both sessions in every generation')
    }
  } finally {
    await Promise.all(clients.map((client) => client.disconnectOnly()))
    clients.forEach((client) => client.dispose())
  }
}

function createRuntimeClosePath(
  config: ClientConfig,
  router: DaemonPtyRouter
): Promise<{
  dispatcher: RpcDispatcher
  targets: Map<string, { publicationEpoch: string; terminal: string }>
  pendingShutdowns: Promise<void>[]
}> {
  const pendingShutdowns: Promise<void>[] = []
  const surfaces = config.sessions.map((session, index) => {
    // Why: app relaunch must target the same persisted mirror incarnation, not
    // accidentally mint a different tab identity that weakens the repetition proof.
    const leafId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
    return { session, leafId, mobileTabId: `${PARENT_TAB_ID}::${leafId}` }
  })
  const runtime = new OrcaRuntimeService()
  runtime.setPtyController({
    write: (ptyId, data) => {
      router.write(ptyId, data)
      return true
    },
    kill: (ptyId) => {
      const shutdown = router.shutdown(ptyId, { immediate: false })
      pendingShutdowns.push(shutdown)
      return true
    },
    listProcesses: (options) => router.listProcesses(options),
    hasPty: (ptyId) => router.hasPty(ptyId),
    getForegroundProcess: (ptyId) => router.getForegroundProcess(ptyId)
  })
  runtime.setNotifier({
    closeTerminal: (tabId: string) => {
      throw new Error(`Reconnect fixture unexpectedly fell back to renderer tab close: ${tabId}`)
    }
  } as never)
  runtime.attachWindow(1)
  const snapshot: RuntimeMobileSessionTabsSnapshot = {
    worktree: WORKTREE_ID,
    publicationEpoch: 'stale-remote-mirror',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: surfaces[0]?.mobileTabId ?? null,
    activeTabType: surfaces.length > 0 ? 'terminal' : null,
    tabs: surfaces.map((surface, index) => ({
      type: 'terminal',
      id: surface.mobileTabId,
      parentTabId: PARENT_TAB_ID,
      leafId: surface.leafId,
      ptyId: surface.session.sessionId,
      title: surface.session.label,
      isActive: index === 0
    }))
  }
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: PARENT_TAB_ID,
        worktreeId: WORKTREE_ID,
        title: 'Reconnect fixture',
        activeLeafId: surfaces[0]?.leafId ?? null,
        layout: null
      }
    ],
    leaves: surfaces.map((surface, index) => ({
      tabId: PARENT_TAB_ID,
      worktreeId: WORKTREE_ID,
      leafId: surface.leafId,
      paneRuntimeId: index + 1,
      ptyId: surface.session.sessionId,
      paneTitle: surface.session.label
    })),
    mobileSessionTabs: [snapshot]
  })
  return runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`).then((accepted) => {
    const acceptedTerminalIds = accepted.tabs.flatMap((tab) =>
      tab.type === 'terminal' ? [tab.id] : []
    )
    if (!surfaces.every((surface) => acceptedTerminalIds.includes(surface.mobileTabId))) {
      throw new Error(`Runtime did not retain reconnect surfaces: ${JSON.stringify(accepted.tabs)}`)
    }
    const internals = runtime as unknown as {
      tabs: Map<string, unknown>
      mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
    }
    const stored = internals.mobileSessionTabsByWorktree.get(WORKTREE_ID)
    const storedLeafCount =
      stored?.tabs.filter((tab) => tab.type === 'terminal' && tab.parentTabId === PARENT_TAB_ID)
        .length ?? 0
    if (!internals.tabs.has(PARENT_TAB_ID) || storedLeafCount !== surfaces.length) {
      throw new Error(
        `Runtime close precondition drifted: parent=${internals.tabs.has(PARENT_TAB_ID)} leaves=${storedLeafCount}`
      )
    }
    return {
      dispatcher: new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS }),
      targets: new Map(
        surfaces
          .filter((surface) => surface.session.role === 'stale-mirror')
          .map((surface) => {
            const acceptedTab = accepted.tabs.find((tab) => tab.id === surface.mobileTabId)
            if (!acceptedTab || acceptedTab.type !== 'terminal' || acceptedTab.status !== 'ready') {
              throw new Error(`Missing lifecycle claim for ${surface.mobileTabId}`)
            }
            return [
              surface.mobileTabId,
              {
                publicationEpoch: accepted.publicationEpoch,
                terminal: acceptedTab.terminal
              }
            ] as const
          })
      ),
      pendingShutdowns
    }
  })
}

async function waitForFinish(): Promise<void> {
  await new Promise<void>((resolve) => {
    process.on('message', (message) => {
      if ((message as { type?: unknown })?.type === 'finish') {
        resolve()
      }
    })
  })
}

async function main(): Promise<void> {
  const config = readConfig()
  let router: DaemonPtyRouter | null = null
  try {
    for (let burst = 1; burst <= config.reconnectBursts; burst += 1) {
      if (router) {
        await router.disconnectOnly()
        router.dispose()
      }
      router = await connectThroughDesktopDiscovery(config, burst)
    }
    await connectParallelRuntimeClients(config)
    const { dispatcher, targets, pendingShutdowns } = await createRuntimeClosePath(config, router)
    await dispatchFixtureCloseBursts({ dispatcher, worktreeId: WORKTREE_ID, targets })
    const shutdownResults = await Promise.allSettled(pendingShutdowns)
    const finish = waitForFinish()
    process.send?.({
      type: 'close-bursts-complete',
      closeAttempts: Object.fromEntries([...targets.keys()].map((tabId) => [tabId, 3])),
      shutdownResults: shutdownResults.map((result) => result.status)
    })
    await finish
  } finally {
    await router?.disconnectOnly().catch(() => {})
    router?.dispose()
  }
}

void main().catch((error) => {
  process.send?.({
    type: 'error',
    message: error instanceof Error ? error.stack : String(error)
  })
  process.exit(1)
})
