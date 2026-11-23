// Whether a bot's paired server is down right now, read from the same status the bot page's outage card reads.
import { useRuntimeHostStatusSelector } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import { runtimeHostConnectionStateForEntry } from '@/runtime/hosts/connections/runtime-host-connection-state'
import { nativeChatHostOutageKind } from '@/components/native-chat/host-access/native-chat-host-outage-latch'
import { botHostTarget } from '@/lib/bot-hosts'
import { useAppStore } from '@/store'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { runtimeHostContactFromSnapshot } from '../../../../shared/remote-runtime/host-status/runtime-host-contact'
import type { RuntimeEnvironmentStatus } from '../../../../shared/remote-runtime/host-status/runtime-host-status'

/**
 * `reconnectable`: false for a server that refused this client or a stopped WSL distro, which
 * Reconnect can't bring back; its failure keeps its own words, yet it is still down.
 */
export type BotHostOutage = {
  kind: 'reconnecting' | 'offline'
  environmentId: string
  reconnectable: boolean
}

type HostDown = { kind: BotHostOutage['kind']; refused: boolean } | null

const hostDown = (entry: RuntimeEnvironmentStatus | undefined): HostDown => {
  const refused = entry?.snapshot
    ? runtimeHostContactFromSnapshot(entry.snapshot, entry.status).verdict === 'refused'
    : false
  const kind = nativeChatHostOutageKind(runtimeHostConnectionStateForEntry(entry))
  return kind === null
    ? null
    : { kind: kind === 'reconnecting' ? 'reconnecting' : 'offline', refused }
}

/** Null for this computer's own bots, and for a server that answers. */
export function useBotHostOutage(hostId: ExecutionHostId): BotHostOutage | null {
  const target = botHostTarget(hostId)
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  // Two primitives, so an unrelated status write wakes nothing.
  const kind = useRuntimeHostStatusSelector(environmentId, (entry) =>
    environmentId === null ? null : (hostDown(entry)?.kind ?? null)
  )
  const refused = useRuntimeHostStatusSelector(environmentId, (entry) =>
    environmentId === null ? false : hostDown(entry)?.refused === true
  )
  const distroStopped = useAppStore(
    (state) =>
      environmentId !== null && state.wslHostStatuses[environmentId]?.state === 'distro-stopped'
  )
  return kind === null || environmentId === null
    ? null
    : { kind, environmentId, reconnectable: !refused && !distroStopped }
}
