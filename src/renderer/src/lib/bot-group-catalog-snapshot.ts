// Each listed host's last group list, held apart from bot-group-catalog so store code can read it without importing the store.
import type { BotGroup } from '../../../shared/bots/bot-group'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../shared/execution-host/execution-host'
import { readBotHostIds } from './bot-catalog-snapshot'
import { keepBotHostList, readKeptBotHostList } from './bot-host-kept-lists'

const byHost = new Map<ExecutionHostId, readonly BotGroup[]>()
let groups: readonly BotGroup[] = []
const listeners = new Set<() => void>()

/** Every group names the host that listed it; a host stores `local` for its own groups. */
function stamp(hostId: ExecutionHostId, next: readonly BotGroup[]): readonly BotGroup[] {
  return next.every((group) => group.hostId === hostId)
    ? next
    : // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stored type names only the host's own `local`; the listing host is the truth here.
      next.map((group) => ({ ...group, hostId }) as BotGroup)
}

/** A group a host answered with, stamped with that host, as its listing would. */
export function stampBotGroupHost(hostId: ExecutionHostId, group: BotGroup): BotGroup {
  return stamp(hostId, [group])[0]
}

function reflatten(): void {
  const hostIds = readBotHostIds()
  // One host hands out its own list, so React sees a stable value.
  groups =
    hostIds.length === 1
      ? (byHost.get(hostIds[0]) ?? [])
      : hostIds.flatMap((id) => byHost.get(id) ?? [])
  listeners.forEach((listener) => listener())
}

export function publishBotGroups(
  next: readonly BotGroup[],
  hostId: ExecutionHostId = LOCAL_EXECUTION_HOST_ID
): void {
  byHost.set(hostId, stamp(hostId, next))
  if (hostId !== LOCAL_EXECUTION_HOST_ID) {
    keepBotHostList(hostId, { groups: next })
  }
  reflatten()
}

/** Follows the listed hosts: a dropped host's groups go with it; a server first listed starts from its kept groups. */
export function retainListedBotGroupHosts(): void {
  const listed = new Set(readBotHostIds())
  const dropped = [...byHost.keys()].filter((hostId) => !listed.has(hostId))
  const seeded = [...listed].flatMap((hostId) => {
    const kept = byHost.has(hostId) ? null : readKeptBotHostList(hostId)
    return kept && kept.groups.length > 0 ? [[hostId, kept.groups] as const] : []
  })
  if (dropped.length === 0 && seeded.length === 0) {
    return
  }
  for (const hostId of dropped) {
    byHost.delete(hostId)
  }
  for (const [hostId, groups] of seeded) {
    byHost.set(hostId, stamp(hostId, groups))
  }
  reflatten()
}

/** Every listed host's groups. */
export function readBotGroups(): readonly BotGroup[] {
  return groups
}

export function subscribeToBotGroupChanges(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
