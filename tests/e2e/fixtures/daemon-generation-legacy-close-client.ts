import { readFileSync } from 'node:fs'
import process from 'node:process'
import { OrcaRuntimeService } from '../../../src/main/runtime/orca-runtime'
import { RpcDispatcher } from '../../../src/main/runtime/rpc/dispatcher'
import { SESSION_TAB_METHODS } from '../../../src/main/runtime/rpc/methods/session-tabs'
import { SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../src/shared/runtime-types'
import { createDesktopDiscoveredDaemonRouter } from './daemon-generation-desktop-discovery'

type FixtureSession = {
  protocolVersion: number
  sessionId: string
  rootPid: number
  worktreeId: string
  tabId: string
  closeContract: 'capable' | 'legacy'
}

type FixtureConfig = {
  generations: { protocolVersion: number; socketPath: string; tokenPath: string }[]
  currentProtocolVersion: number
  daemonDir: string
  historyDir: string
  cwd: string
  sessions: FixtureSession[]
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

const LEGACY_VIEWER = {
  clientKind: 'runtime' as const,
  clientId: 'legacy-viewer',
  pairedDeviceId: 'legacy-viewer',
  connectionId: 'legacy-viewer-generation-1',
  callSite: 'legacy-viewer:stale-pty-exit-cleanup',
  wireReason: null
}
const CAPABLE_VIEWER = {
  clientKind: 'runtime' as const,
  clientId: 'capable-viewer',
  pairedDeviceId: 'capable-viewer',
  connectionId: 'capable-viewer-generation-2',
  clientCapabilities: [SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY],
  callSite: 'capable-viewer:stale-pty-exit-cleanup',
  wireReason: null
}
const OBSERVER = {
  clientKind: 'runtime' as const,
  clientId: 'current-viewer',
  pairedDeviceId: 'current-viewer',
  connectionId: 'observer-generation-3'
}

function readConfig(): FixtureConfig {
  const configIndex = process.argv.indexOf('--config')
  const configPath = configIndex !== -1 ? process.argv[configIndex + 1] : undefined
  if (!configPath) {
    throw new Error('Legacy close client requires --config <path>')
  }
  return JSON.parse(readFileSync(configPath, 'utf8')) as FixtureConfig
}

async function dispatchReasonlessClose(
  dispatcher: RpcDispatcher,
  session: FixtureSession,
  sequence: number,
  viewer: typeof LEGACY_VIEWER | typeof CAPABLE_VIEWER
): Promise<Record<string, unknown>> {
  const requestId = `${session.closeContract}-close-${sequence}`
  return await new Promise((resolve, reject) => {
    void dispatcher
      .dispatchStreaming(
        {
          id: requestId,
          authToken: 'fixture-only',
          method: 'session.tabs.close',
          params: { worktree: `id:${session.worktreeId}`, tabId: session.tabId }
        },
        (serialized) => resolve(JSON.parse(serialized) as Record<string, unknown>),
        viewer
      )
      .catch(reject)
  })
}

async function dispatchObserverList(
  dispatcher: RpcDispatcher,
  session: FixtureSession,
  sequence: number
): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    void dispatcher
      .dispatchStreaming(
        {
          id: `observer-list-${sequence}`,
          authToken: 'fixture-only',
          method: 'session.tabs.list',
          params: { worktree: `id:${session.worktreeId}` }
        },
        (serialized) => resolve(JSON.parse(serialized) as Record<string, unknown>),
        OBSERVER
      )
      .catch(reject)
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
  const { router } = await createDesktopDiscoveredDaemonRouter(config)
  try {
    const outputBySessionId = new Map<string, string>()
    router.onData((event) => {
      outputBySessionId.set(
        event.id,
        `${outputBySessionId.get(event.id) ?? ''}${event.data}`.slice(-32_768)
      )
    })
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
        throw new Error(`Legacy close fixture changed ${session.sessionId} incarnation`)
      }
    }

    const runtime = new OrcaRuntimeService()
    const calls: Record<string, unknown>[] = []
    const sessionByTabId = new Map(config.sessions.map((session) => [session.tabId, session]))
    runtime.setPtyController({
      write: (ptyId, data) => {
        router.write(ptyId, data)
        return true
      },
      kill: () => false,
      listProcesses: (options) => router.listProcesses(options),
      hasPty: (ptyId) => router.hasPty(ptyId),
      getForegroundProcess: (ptyId) => router.getForegroundProcess(ptyId)
    })
    runtime.setNotifier({
      closeTerminal: () => {
        throw new Error('Legacy close fixture unexpectedly used the pane-close fallback')
      },
      closeTerminalTab: async (tabId: string) => {
        const session = sessionByTabId.get(tabId)
        if (!session) {
          throw new Error(`Legacy close fixture received unknown tab ${tabId}`)
        }
        calls.push({
          callSite: 'RuntimeNotifier.closeTerminalTab -> DaemonPtyRouter.shutdown',
          immediate: true,
          tabId,
          worktreeId: session.worktreeId,
          sessionId: session.sessionId
        })
        await router.shutdown(session.sessionId, { immediate: true })
      }
    } as never)
    runtime.attachWindow(1)

    const snapshots: RuntimeMobileSessionTabsSnapshot[] = config.sessions.map((session, index) => {
      const leafId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
      return {
        worktree: session.worktreeId,
        publicationEpoch: `legacy-viewer-${index + 1}`,
        snapshotVersion: 1,
        activeGroupId: null,
        activeTabId: `${session.tabId}::${leafId}`,
        activeTabType: 'terminal',
        tabs: [
          {
            type: 'terminal',
            id: `${session.tabId}::${leafId}`,
            parentTabId: session.tabId,
            leafId,
            ptyId: session.sessionId,
            title: session.tabId,
            isActive: true
          }
        ]
      }
    })
    runtime.syncWindowGraph(1, {
      tabs: snapshots.map((snapshot) => ({
        tabId: snapshot.tabs[0]!.parentTabId,
        worktreeId: snapshot.worktree,
        title: snapshot.tabs[0]!.title,
        activeLeafId: snapshot.tabs[0]!.leafId,
        layout: null
      })),
      leaves: snapshots.map((snapshot, index) => ({
        tabId: snapshot.tabs[0]!.parentTabId,
        worktreeId: snapshot.worktree,
        leafId: snapshot.tabs[0]!.leafId,
        paneRuntimeId: index + 1,
        ptyId: config.sessions[index]!.sessionId,
        paneTitle: snapshot.tabs[0]!.title
      })),
      mobileSessionTabs: snapshots
    })

    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const observerBefore: Record<string, unknown>[] = []
    for (const [index, session] of config.sessions.entries()) {
      observerBefore.push(await dispatchObserverList(dispatcher, session, index + 1))
    }
    const capableResponses: Record<string, unknown>[] = []
    for (const [index, session] of config.sessions
      .filter((candidate) => candidate.closeContract === 'capable')
      .entries()) {
      capableResponses.push(
        await dispatchReasonlessClose(dispatcher, session, index + 1, CAPABLE_VIEWER)
      )
    }
    const observerAfterCapable: Record<string, unknown>[] = []
    for (const [index, session] of config.sessions.entries()) {
      observerAfterCapable.push(await dispatchObserverList(dispatcher, session, index + 101))
    }
    const legacyResponses: Record<string, unknown>[] = []
    for (const [index, session] of config.sessions
      .filter((candidate) => candidate.closeContract === 'legacy')
      .entries()) {
      legacyResponses.push(
        await dispatchReasonlessClose(dispatcher, session, index + 1, LEGACY_VIEWER)
      )
    }
    const observerAfter: Record<string, unknown>[] = []
    for (const [index, session] of config.sessions.entries()) {
      observerAfter.push(await dispatchObserverList(dispatcher, session, index + 201))
    }
    const postClosePing: Record<string, boolean> = {}
    for (const [index, session] of config.sessions.entries()) {
      if (calls.some((call) => call.sessionId === session.sessionId)) {
        postClosePing[session.sessionId] = false
        continue
      }
      const nonce = `post-close-${index + 1}`
      try {
        router.write(
          session.sessionId,
          `PING legacy-close-v${session.protocolVersion}-live ${nonce}\r`
        )
        await waitFor(`${session.sessionId} post-close reply`, () =>
          (outputBySessionId.get(session.sessionId) ?? '').includes(
            `ORCA_GENERATION_CANARY_ACK legacy-close-v${session.protocolVersion}-live ${nonce}`
          )
        )
        postClosePing[session.sessionId] = true
      } catch {
        postClosePing[session.sessionId] = false
      }
    }
    process.send?.({
      type: 'legacy-close-complete',
      capableInitiator: CAPABLE_VIEWER,
      legacyInitiator: LEGACY_VIEWER,
      observer: {
        ...OBSERVER,
        requestCount: observerBefore.length + observerAfterCapable.length + observerAfter.length,
        closeRequestCount: 0
      },
      observerBefore,
      observerAfterCapable,
      observerAfter,
      postClosePing,
      calls,
      capableResponses,
      legacyResponses
    })
    await waitForFinish()
  } finally {
    await router.disconnectOnly().catch(() => {})
    router.dispose()
  }
}

void main().catch((error) => {
  process.send?.({
    type: 'error',
    message: error instanceof Error ? error.stack : String(error)
  })
  process.exit(1)
})
