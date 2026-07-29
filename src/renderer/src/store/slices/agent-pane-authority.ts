import { parsePaneKey } from '../../../../shared/stable-pane-id'

type AgentPaneAuthorityAlias = {
  ownerPaneKey: string
  ptyId: string | null
}

const aliasesByPhysicalPaneKey = new Map<string, AgentPaneAuthorityAlias>()

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
  if (physicalPaneKey !== args.toPaneKey) {
    // Why: the process keeps posting its original ORCA_PANE_KEY after detach;
    // one physical-to-owner alias keeps chained moves on the current surface.
    aliasesByPhysicalPaneKey.set(physicalPaneKey, {
      ownerPaneKey: args.toPaneKey,
      ptyId
    })
  }
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

export function resetAgentPaneAuthorityAliasesForTests(): void {
  aliasesByPhysicalPaneKey.clear()
}
