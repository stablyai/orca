// Agent terminals that outlive their host's restart keep the relay address and token of its last
// run, so every server reached through it stops working. Once each host has started and taken its
// terminals back (Orca itself, or a new run of a remote host), offer the restart an edit offers.
import { useEffect } from 'react'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { toast } from 'sonner'
import { useAppStore } from '../../../store/index'
import { useRuntimeStatusByEnvironmentId } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { MCP_SERVERS_RUNTIME_CAPABILITY } from '../../../../../shared/mcp-servers/mcp-servers'
import { ensureLocalRuntimeCapabilities } from '@/runtime/hosts/capabilities/local-runtime-capabilities'
import { remoteRestartRuntimeId } from '../../native-chat-recovery/offers/native-chat-remote-restart-offer'
import { mcpStaleTerminalsToastId, showMcpStaleTerminalsToast } from './mcp-server-change-toast'

// A host that just started can refuse until it has taken its terminals back (orcad waits 10 s).
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000] as const

/** What each host was last asked: once per host run, however often its status changes. A run that
 *  never answered is asked again only once the host's contact is regained. */
type Ask = { run: string; contact: number; unanswered: boolean }
const asks = new Map<string, Ask>()

function askOnce(
  hostKey: string,
  host: { run: string; contact: number },
  target: RuntimeClientTarget,
  hostName: string | null
): void {
  const previous = asks.get(hostKey)
  if (previous?.run === host.run && (!previous.unanswered || previous.contact === host.contact)) {
    return
  }
  const ask: Ask = { ...host, unanswered: false }
  asks.set(hostKey, ask)
  // A newer run of the host, or its removal, takes over.
  const current = () => asks.get(hostKey) === ask
  void (async () => {
    for (const delay of [0, ...RETRY_DELAYS_MS]) {
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
      if (!current() || (await showMcpStaleTerminalsToast(target, hostName, current))) {
        return
      }
    }
    ask.unanswered = true
  })()
}

export function McpStaleTerminalsStartupOffer(): null {
  // Restoration has adopted every terminal that outlived the restart by then.
  const localReady = useAppStore(
    (state) => state.workspaceSessionReady && state.terminalStartupRestorationReady
  )
  const environments = useAppStore((state) => state.runtimeEnvironments)
  const statuses = useRuntimeStatusByEnvironmentId()
  useEffect(() => {
    // A paired web client's local host is its paired host, asked below as an environment.
    if (!localReady || isWebClientLocation()) {
      return
    }
    // A host without the MCP switch on has no such terminals: it isn't asked at all.
    void ensureLocalRuntimeCapabilities().then((capabilities) => {
      if (capabilities?.includes(MCP_SERVERS_RUNTIME_CAPABILITY)) {
        askOnce('local', { run: 'local', contact: 0 }, { kind: 'local' }, null)
      }
    })
  }, [localReady])
  useEffect(() => {
    const enrolled = new Set(environments.map((environment) => environment.id))
    for (const hostKey of asks.keys()) {
      if (hostKey !== 'local' && !enrolled.has(hostKey)) {
        asks.delete(hostKey)
        toast.dismiss(mcpStaleTerminalsToastId({ kind: 'environment', environmentId: hostKey }))
      }
    }
    for (const environment of environments) {
      const status = statuses.get(environment.id)
      const runtimeId = remoteRestartRuntimeId(status)
      if (runtimeId && status?.status?.capabilities?.includes(MCP_SERVERS_RUNTIME_CAPABILITY)) {
        askOnce(
          environment.id,
          { run: runtimeId, contact: status.hostContactEpoch ?? 0 },
          { kind: 'environment', environmentId: environment.id },
          environment.name || environment.id
        )
      }
    }
  }, [environments, statuses])
  return null
}
