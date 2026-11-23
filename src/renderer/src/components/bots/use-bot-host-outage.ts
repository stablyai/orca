// Whether a bot's paired server is down right now, read from the same status the bot page's outage card reads.
import { useRuntimeHostStatusSelector } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import { runtimeHostConnectionStateForEntry } from '@/runtime/hosts/connections/runtime-host-connection-state'
import { nativeChatHostOutageKind } from '@/components/native-chat/host-access/native-chat-host-outage-latch'
import { botHostTarget } from '@/lib/bot-hosts'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { RuntimeEnvironmentStatus } from '../../../../shared/remote-runtime/host-status/runtime-host-status'

export type BotHostOutage = { kind: 'reconnecting' | 'offline'; environmentId: string }

const outageKind = (entry: RuntimeEnvironmentStatus | undefined): BotHostOutage['kind'] | null => {
  const kind = nativeChatHostOutageKind(runtimeHostConnectionStateForEntry(entry))
  return kind === null ? null : kind === 'reconnecting' ? 'reconnecting' : 'offline'
}

/** Null for this computer's own bots, and for a server that answers. */
export function useBotHostOutage(hostId: ExecutionHostId): BotHostOutage | null {
  const target = botHostTarget(hostId)
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  const kind = useRuntimeHostStatusSelector(environmentId, (entry) =>
    environmentId === null ? null : outageKind(entry)
  )
  return kind === null || environmentId === null ? null : { kind, environmentId }
}
