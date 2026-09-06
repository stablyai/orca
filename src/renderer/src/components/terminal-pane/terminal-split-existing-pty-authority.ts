import type { AppState } from '@/store'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/stable-pane-id'

type ExistingPtyAuthorityStore = Pick<
  AppState,
  'tabsByWorktree' | 'terminalLayoutsByTabId' | 'transferAgentPaneAuthority'
>

export function transferExistingPtyAgentPaneAuthority(args: {
  leafId: string
  ptyId: string
  state: ExistingPtyAuthorityStore
  tabId: string
  worktreeId: string
}): boolean {
  if (!isTerminalLeafId(args.leafId)) {
    return false
  }
  const workspaceTabIds = new Set(
    (args.state.tabsByWorktree[args.worktreeId] ?? []).map((tab) => tab.id)
  )
  if (!workspaceTabIds.has(args.tabId)) {
    return false
  }

  let sourcePaneKey: string | null = null
  for (const candidateTabId of workspaceTabIds) {
    if (candidateTabId === args.tabId) {
      continue
    }
    const bindings = args.state.terminalLayoutsByTabId[candidateTabId]?.ptyIdsByLeafId ?? {}
    for (const [candidateLeafId, candidatePtyId] of Object.entries(bindings)) {
      if (candidatePtyId !== args.ptyId) {
        continue
      }
      if (!isTerminalLeafId(candidateLeafId) || sourcePaneKey !== null) {
        return false
      }
      sourcePaneKey = makePaneKey(candidateTabId, candidateLeafId)
    }
  }
  if (!sourcePaneKey) {
    return false
  }

  args.state.transferAgentPaneAuthority({
    fromPaneKey: sourcePaneKey,
    toPaneKey: makePaneKey(args.tabId, args.leafId),
    ptyId: args.ptyId
  })
  return true
}
