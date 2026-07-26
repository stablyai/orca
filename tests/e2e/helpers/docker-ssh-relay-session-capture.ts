import type { ElectronApplication } from '@stablyai/playwright-test'

export type DockerRelaySnapshotCapture = {
  archiveAttempt: number
  leafId: string
  lostPaneKey: string | null
  lostReplayTail: 'present' | 'absent'
  paneKeyMatchesLost: boolean
  result: 'captured-bytes' | 'captured-empty' | 'unavailable'
  sidecar: 'inline' | 'scrollback-ref' | 'none'
  source: string | null
}

type RelaySessionForE2E = {
  currentConnection?: unknown
  reconnect: (connection: unknown, graceTimeSeconds?: number) => Promise<void>
}

type MainE2EScope = typeof globalThis & {
  __orcaE2eRelaySessions?: Map<string, RelaySessionForE2E>
  __orcaE2eRestoreMapSet?: () => void
  __orcaE2eRelaySnapshotCaptures?: DockerRelaySnapshotCapture[]
  __orcaE2eRestoreRelaySnapshotProbe?: () => void
}

export async function installDockerRelaySessionCapture(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const scope = globalThis as MainE2EScope
    if (!scope.__orcaE2eRelaySessions) {
      const sessions = new Map<string, RelaySessionForE2E>()
      const originalSet = Map.prototype.set
      Map.prototype.set = function captureRelaySession(key: unknown, value: unknown) {
        const candidate = value as Partial<RelaySessionForE2E> & { targetId?: unknown }
        if (
          typeof key === 'string' &&
          candidate?.targetId === key &&
          typeof candidate.reconnect === 'function'
        ) {
          Reflect.apply(originalSet, sessions, [key, candidate as RelaySessionForE2E])
        }
        return Reflect.apply(originalSet, this, [key, value])
      }
      scope.__orcaE2eRelaySessions = sessions
      scope.__orcaE2eRestoreMapSet = () => {
        Map.prototype.set = originalSet
        delete scope.__orcaE2eRelaySessions
        delete scope.__orcaE2eRestoreMapSet
      }
    }
  })
}

export async function assertDockerRelaySessionCaptured(
  app: ElectronApplication,
  targetId: string
): Promise<void> {
  await app.evaluate((_electron, id) => {
    if (!(globalThis as MainE2EScope).__orcaE2eRelaySessions?.has(id)) {
      throw new Error(`SSH relay session ${id} was not captured during target connection`)
    }
  }, targetId)
}

export async function reconnectCapturedDockerRelay(
  app: ElectronApplication,
  targetId: string
): Promise<void> {
  await app.evaluate(async (_electron, id) => {
    const scope = globalThis as MainE2EScope
    const session = scope.__orcaE2eRelaySessions?.get(id)
    if (!session?.currentConnection) {
      throw new Error(`SSH relay session ${id} has no live connection`)
    }
    await session.reconnect(session.currentConnection, 1)
  }, targetId)
}

export async function capturedDockerRelayWorkspacePtyCount(
  app: ElectronApplication,
  targetId: string,
  tabId: string
): Promise<number> {
  return app.evaluate(
    (_electron, { targetId: capturedTargetId, tabId: capturedTabId }) => {
      const session = (globalThis as MainE2EScope).__orcaE2eRelaySessions?.get(capturedTargetId) as
        | (RelaySessionForE2E & { store?: { getWorkspaceSession?: (hostId: string) => unknown } })
        | undefined
      const workspaceSession = session?.store?.getWorkspaceSession?.(`ssh:${capturedTargetId}`) as
        | { terminalLayoutsByTabId?: Record<string, { ptyIdsByLeafId?: Record<string, string> }> }
        | undefined
      return Object.keys(
        workspaceSession?.terminalLayoutsByTabId?.[capturedTabId]?.ptyIdsByLeafId ?? {}
      ).length
    },
    { targetId, tabId }
  )
}

export async function installDockerRelaySnapshotCaptureProbe(
  app: ElectronApplication,
  targetId: string
): Promise<void> {
  await app.evaluate((_electron, capturedTargetId) => {
    const scope = globalThis as MainE2EScope
    if (scope.__orcaE2eRestoreRelaySnapshotProbe) {
      return
    }
    const session = scope.__orcaE2eRelaySessions?.get(capturedTargetId) as
      | (RelaySessionForE2E & {
          archiveRelayLostWorker?: (args: unknown) => Promise<void>
          store?: {
            createTerminalArchiveStore?: (snapshotSource: {
              capture: (pane: unknown) => Promise<unknown>
            }) => unknown
            getWorkspaceSession?: (hostId: string) => unknown
          }
        })
      | undefined
    const store = session?.store
    const originalArchiveRelayLostWorker = session?.archiveRelayLostWorker
    const originalCreateTerminalArchiveStore = store?.createTerminalArchiveStore
    if (
      !session ||
      !store ||
      !originalArchiveRelayLostWorker ||
      !originalCreateTerminalArchiveStore ||
      !store.getWorkspaceSession
    ) {
      throw new Error(
        `SSH relay session ${capturedTargetId} cannot expose its archive snapshot seam`
      )
    }

    let archiveAttempt = 0
    let currentLost: Record<string, unknown> | null = null
    const captures: DockerRelaySnapshotCapture[] = []
    session.archiveRelayLostWorker = async (args: unknown) => {
      archiveAttempt += 1
      currentLost =
        args && typeof args === 'object' && 'lost' in args
          ? ((args as { lost?: unknown }).lost as Record<string, unknown>)
          : (args as Record<string, unknown>)
      try {
        await originalArchiveRelayLostWorker.call(session, args)
      } finally {
        currentLost = null
      }
    }
    store.createTerminalArchiveStore = (snapshotSource) => {
      const observedSnapshotSource = {
        capture: async (pane: unknown) => {
          const archivedPane = pane as { archivedLeafId?: unknown }
          const leafId = String(archivedPane.archivedLeafId ?? '')
          const lost = currentLost
          const tabId = typeof lost?.tabId === 'string' ? lost.tabId : ''
          const paneKey = typeof lost?.paneKey === 'string' ? lost.paneKey : null
          const sessionState = store.getWorkspaceSession?.(`ssh:${capturedTargetId}`) as
            | {
                terminalLayoutsByTabId?: Record<
                  string,
                  {
                    buffersByLeafId?: Record<string, unknown>
                    scrollbackRefsByLeafId?: Record<string, unknown>
                  }
                >
              }
            | undefined
          const layout = sessionState?.terminalLayoutsByTabId?.[tabId]
          const hasInlineSidecar = typeof layout?.buffersByLeafId?.[leafId] === 'string'
          const hasScrollbackRef = typeof layout?.scrollbackRefsByLeafId?.[leafId] === 'string'
          const result = (await snapshotSource.capture(pane)) as {
            kind?: unknown
            source?: unknown
          }
          const resultKind = result.kind
          if (
            resultKind !== 'captured-bytes' &&
            resultKind !== 'captured-empty' &&
            resultKind !== 'unavailable'
          ) {
            throw new Error(`Unexpected relay snapshot result: ${String(resultKind)}`)
          }
          captures.push({
            archiveAttempt,
            leafId,
            lostPaneKey: paneKey,
            lostReplayTail:
              typeof (lost?.replayTail as { data?: unknown } | undefined)?.data === 'string'
                ? 'present'
                : 'absent',
            paneKeyMatchesLost: paneKey === `${tabId}:${leafId}`,
            result: resultKind,
            sidecar: hasInlineSidecar ? 'inline' : hasScrollbackRef ? 'scrollback-ref' : 'none',
            source: typeof result.source === 'string' ? result.source : null
          })
          return result
        }
      }
      return Reflect.apply(originalCreateTerminalArchiveStore, store, [observedSnapshotSource])
    }
    scope.__orcaE2eRelaySnapshotCaptures = captures
    scope.__orcaE2eRestoreRelaySnapshotProbe = () => {
      session.archiveRelayLostWorker = originalArchiveRelayLostWorker
      store.createTerminalArchiveStore = originalCreateTerminalArchiveStore
      delete scope.__orcaE2eRelaySnapshotCaptures
      delete scope.__orcaE2eRestoreRelaySnapshotProbe
    }
  }, targetId)
}

export async function readDockerRelaySnapshotCaptures(
  app: ElectronApplication
): Promise<DockerRelaySnapshotCapture[]> {
  return app.evaluate(() => [
    ...((globalThis as MainE2EScope).__orcaE2eRelaySnapshotCaptures ?? [])
  ])
}

export async function releaseDockerRelaySessionCapture(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const scope = globalThis as MainE2EScope
    scope.__orcaE2eRestoreRelaySnapshotProbe?.()
    scope.__orcaE2eRestoreMapSet?.()
  })
}
