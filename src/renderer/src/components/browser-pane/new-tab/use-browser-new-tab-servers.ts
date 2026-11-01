import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { getWorkspacePortsByWorktreeId } from '@/lib/workspace-port-groups'
import { workspacePortScanKeyForTarget } from '@/lib/workspace-port-actions'
import { refreshWorkspacePortScanForTarget } from '@/lib/workspace-port-scan-refresh'
import { probeWorkspacePortPageForTarget } from '@/lib/workspace-port-scan-client'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import type {
  WorkspacePort,
  WorkspacePortPageProbeResult
} from '../../../../../shared/workspace-ports'

export type BrowserNewTabServer = {
  port: WorkspacePort
  title: string | null
  faviconDataUrl: string | null
}

// Why a short cache: every new tab asks again, and a dev server's page rarely changes in seconds.
const PROBE_TTL_MS = 15_000
const probeCache = new Map<
  string,
  { probedAt: number; result: Promise<WorkspacePortPageProbeResult | null> }
>()

function probeKey(target: RuntimeClientTarget, port: WorkspacePort): string {
  return `${workspacePortScanKeyForTarget(target)}|${port.connectHost}|${port.port}|${port.pid ?? ''}`
}

function probePortPage(
  target: RuntimeClientTarget,
  port: WorkspacePort
): Promise<WorkspacePortPageProbeResult | null> {
  const key = probeKey(target, port)
  const cached = probeCache.get(key)
  if (cached && Date.now() - cached.probedAt < PROBE_TTL_MS) {
    return cached.result
  }
  const advertisedHttps = port.kind === 'workspace' && port.advertisedUrl?.startsWith('https:')
  const result = probeWorkspacePortPageForTarget(target, {
    host: port.connectHost,
    port: port.port,
    protocol: advertisedHttps || port.protocol === 'https' ? 'https' : 'http'
  }).catch((): WorkspacePortPageProbeResult => ({ kind: 'not-page' }))
  probeCache.set(key, { probedAt: Date.now(), result })
  return result
}

export type BrowserNewTabServers = {
  own: BrowserNewTabServer[]
  /** Other worktrees' servers on the same host, so this tab reaches them at the same address. */
  others: BrowserNewTabServer[]
}

export function useBrowserNewTabServers(
  worktreeId: string,
  runtimeTarget: RuntimeClientTarget | null
): BrowserNewTabServers {
  const hostScan = useAppStore((s) =>
    runtimeTarget ? s.workspacePortScansByKey[workspacePortScanKeyForTarget(runtimeTarget)] : null
  )
  const ports = useMemo(
    () => [...getWorkspacePortsByWorktreeId(hostScan).values()].flat(),
    [hostScan]
  )
  const replaceWorkspacePortScans = useAppStore((s) => s.replaceWorkspacePortScans)
  const [probes, setProbes] = useState<ReadonlyMap<string, WorkspacePortPageProbeResult | null>>(
    () => new Map()
  )

  useEffect(() => {
    if (!runtimeTarget) {
      return
    }
    // Why: the background poll runs every 30s; a server started moments ago should be here now.
    void refreshWorkspacePortScanForTarget({
      runtimeTarget,
      replaceWorkspacePortScans,
      getWorkspacePortScansByKey: () => useAppStore.getState().workspacePortScansByKey
    })
  }, [runtimeTarget, replaceWorkspacePortScans])

  useEffect(() => {
    if (!runtimeTarget) {
      return
    }
    let cancelled = false
    for (const port of ports) {
      const key = probeKey(runtimeTarget, port)
      void probePortPage(runtimeTarget, port).then((result) => {
        if (!cancelled) {
          setProbes((previous) =>
            previous.get(key) === result ? previous : new Map(previous).set(key, result)
          )
        }
      })
    }
    return () => {
      cancelled = true
    }
  }, [ports, runtimeTarget])

  const servers = runtimeTarget
    ? ports.flatMap((port): BrowserNewTabServer[] => {
        const probe = probes.get(probeKey(runtimeTarget, port))
        if (probe === undefined) {
          return []
        }
        if (probe === null) {
          // An older host cannot say; a URL its terminal printed is the best evidence of a page.
          return port.kind === 'workspace' && port.advertisedUrl
            ? [{ port, title: null, faviconDataUrl: null }]
            : []
        }
        return probe.kind === 'page'
          ? [{ port, title: probe.title, faviconDataUrl: probe.faviconDataUrl }]
          : []
      })
    : []
  const ownedHere = (server: BrowserNewTabServer): boolean =>
    server.port.kind === 'workspace' && server.port.owner.worktreeId === worktreeId
  return {
    own: servers.filter(ownedHere),
    others: servers.filter((server) => !ownedHere(server))
  }
}
