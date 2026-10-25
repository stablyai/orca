import { parsePaneKey } from '../../../../shared/stable-pane-id'

type AgentPaneAuthorityAlias = {
  ownerPaneKey: string
  ptyId: string | null
}

const aliasesByPhysicalPaneKey = new Map<string, AgentPaneAuthorityAlias>()

// Evict oldest aliases: PTY exit/purge can skip retirement and otherwise leak entries forever.
const MAX_AGENT_PANE_AUTHORITY_ALIASES = 512

function evictOldestAgentPaneAuthorityAliases(): void {
  // Why: mirrors the main-process alias bound (boundPaneKeyAliases) — insertion-order eviction.
  while (aliasesByPhysicalPaneKey.size > MAX_AGENT_PANE_AUTHORITY_ALIASES) {
    const oldestPaneKey = aliasesByPhysicalPaneKey.keys().next().value
    if (!oldestPaneKey) {
      break
    }
    aliasesByPhysicalPaneKey.delete(oldestPaneKey)
  }
}

export type AgentPaneAuthorityTransfer = {
  physicalPaneKey: string
  previousOwnerPaneKey: string
  ownerPaneKey: string
  ptyId: string | null
}

export function resolveAgentPaneAuthorityKey(paneKey: string): string {
  return aliasesByPhysicalPaneKey.get(paneKey)?.ownerPaneKey ?? paneKey
}

export function transferAgentPaneAuthorityAlias(args: {
  fromPaneKey: string
  toPaneKey: string
  ptyId?: string | null
}): AgentPaneAuthorityTransfer | null {
  if (!parsePaneKey(args.fromPaneKey) || !parsePaneKey(args.toPaneKey)) {
    return null
  }
  const previousOwnerPaneKey = resolveAgentPaneAuthorityKey(args.fromPaneKey)
  let physicalPaneKey = args.fromPaneKey
  for (const [candidatePhysicalPaneKey, alias] of aliasesByPhysicalPaneKey) {
    if (
      alias.ownerPaneKey === previousOwnerPaneKey &&
      (!args.ptyId || !alias.ptyId || alias.ptyId === args.ptyId)
    ) {
      physicalPaneKey = candidatePhysicalPaneKey
      break
    }
  }
  const ptyId = args.ptyId?.trim() || aliasesByPhysicalPaneKey.get(physicalPaneKey)?.ptyId || null
  // Move every alias in one hop or chained detach routes intermediate keys to dead panes.
  const formerOwnerPaneKeys = new Set([physicalPaneKey, previousOwnerPaneKey])
  for (const [candidatePhysicalPaneKey, alias] of aliasesByPhysicalPaneKey) {
    if (alias.ownerPaneKey === previousOwnerPaneKey) {
      formerOwnerPaneKeys.add(candidatePhysicalPaneKey)
    }
  }
  for (const formerOwnerPaneKey of formerOwnerPaneKeys) {
    if (formerOwnerPaneKey === args.toPaneKey) {
      // Why: the pane came back to this key, so it owns itself again.
      aliasesByPhysicalPaneKey.delete(formerOwnerPaneKey)
      continue
    }
    // Why: re-insert so an alias refreshed by a later move is not the eviction victim.
    aliasesByPhysicalPaneKey.delete(formerOwnerPaneKey)
    aliasesByPhysicalPaneKey.set(formerOwnerPaneKey, {
      ownerPaneKey: args.toPaneKey,
      ptyId
    })
  }
  evictOldestAgentPaneAuthorityAliases()
  return {
    physicalPaneKey,
    previousOwnerPaneKey,
    ownerPaneKey: args.toPaneKey,
    ptyId
  }
}

export function retireAgentPaneAuthorityAliases(paneKey: string): string[] {
  const ownerPaneKey = resolveAgentPaneAuthorityKey(paneKey)
  const retiredPaneKeys = new Set([paneKey, ownerPaneKey])
  for (const [physicalPaneKey, alias] of aliasesByPhysicalPaneKey) {
    if (physicalPaneKey === paneKey || alias.ownerPaneKey === ownerPaneKey) {
      aliasesByPhysicalPaneKey.delete(physicalPaneKey)
      retiredPaneKeys.add(physicalPaneKey)
      retiredPaneKeys.add(alias.ownerPaneKey)
    }
  }
  return [...retiredPaneKeys]
}

export function retireAgentPaneAuthorityAliasesByOwnerTab(tabId: string): string[] {
  const ownerPrefix = `${tabId}:`
  const retiredPaneKeys = new Set<string>()
  for (const [physicalPaneKey, alias] of aliasesByPhysicalPaneKey) {
    if (!alias.ownerPaneKey.startsWith(ownerPrefix)) {
      continue
    }
    aliasesByPhysicalPaneKey.delete(physicalPaneKey)
    retiredPaneKeys.add(physicalPaneKey)
    retiredPaneKeys.add(alias.ownerPaneKey)
  }
  return [...retiredPaneKeys]
}

/** Drop aliases whose physical or owner pane belongs to a purged tab. */
export function forgetAgentPaneAuthorityAliasesByTabIds(tabIds: Iterable<string>): void {
  const doomedTabIds = tabIds instanceof Set ? tabIds : new Set(tabIds)
  if (doomedTabIds.size === 0) {
    return
  }
  for (const [physicalPaneKey, alias] of aliasesByPhysicalPaneKey) {
    const physicalTabId = parsePaneKey(physicalPaneKey)?.tabId
    const ownerTabId = parsePaneKey(alias.ownerPaneKey)?.tabId
    if (
      (physicalTabId && doomedTabIds.has(physicalTabId)) ||
      (ownerTabId && doomedTabIds.has(ownerTabId))
    ) {
      aliasesByPhysicalPaneKey.delete(physicalPaneKey)
    }
  }
}

export function countAgentPaneAuthorityAliasesForTests(): number {
  return aliasesByPhysicalPaneKey.size
}

export function resetAgentPaneAuthorityAliasesForTests(): void {
  aliasesByPhysicalPaneKey.clear()
}
