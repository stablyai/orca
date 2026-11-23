// Whether a bot's paired server is down right now, read from the same status the bot page's outage card reads.
import { useRuntimeHostStatusSelector } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import { runtimeHostConnectionStateForEntry } from '@/runtime/hosts/connections/runtime-host-connection-state'
import { nativeChatHostOutageKind } from '@/components/native-chat/host-access/native-chat-host-outage-latch'
import { botHostTarget } from '@/lib/bot-hosts'
import { useAppStore } from '@/store'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { runtimeHostContactFromSnapshot } from '../../../../shared/remote-runtime/host-status/runtime-host-contact'
import type { RuntimeEnvironmentStatus } from '../../../../shared/remote-runtime/host-status/runtime-host-status'

export type BotHostOutage = { kind: 'reconnecting' | 'offline'; environmentId: string }

const outageKind = (entry: RuntimeEnvironmentStatus | undefined): BotHostOutage['kind'] | null => {
  // A host that refused this client won't come back by reconnecting: its failure keeps its own words.
  if (
    entry?.snapshot &&
    runtimeHostContactFromSnapshot(entry.snapshot, entry.status).verdict === 'refused'
  ) {
    return null
  }
  const kind = nativeChatHostOutageKind(runtimeHostConnectionStateForEntry(entry))
  return kind === null ? null : kind === 'reconnecting' ? 'reconnecting' : 'offline'
}

/** Null for this computer's own bots, a server that answers, and one Reconnect can't bring back. */
export function useBotHostOutage(hostId: ExecutionHostId): BotHostOutage | null {
  const target = botHostTarget(hostId)
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  const kind = useRuntimeHostStatusSelector(environmentId, (entry) =>
    environmentId === null ? null : outageKind(entry)
  )
  // A stopped WSL distro needs starting, which Reconnect can't do: its failure keeps its own words.
  const distroStopped = useAppStore(
    (state) =>
      environmentId !== null && state.wslHostStatuses[environmentId]?.state === 'distro-stopped'
  )
  return kind === null || environmentId === null || distroStopped ? null : { kind, environmentId }
}
