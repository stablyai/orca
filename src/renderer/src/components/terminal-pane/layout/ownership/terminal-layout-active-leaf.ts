import type { TerminalPaneLayoutNode } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import { collectLeafIdsInOrder } from '../terminal-layout-leaf-traversal'

function hasLeafPtyBinding(
  ptyIdsByLeafId: Record<string, string> | undefined,
  leafId: string
): boolean {
  return ptyIdsByLeafId ? Object.hasOwn(ptyIdsByLeafId, leafId) : false
}

export function resolveTerminalLayoutActiveLeafId(opts: {
  root: TerminalPaneLayoutNode | null | undefined
  activeLeafId: string | null | undefined
  ptyIdsByLeafId?: Record<string, string>
}): string | null {
  const leafIds = collectLeafIdsInOrder(opts.root)
  if (leafIds.length === 0) {
    return null
  }

  const leafIdSet = new Set(leafIds)
  const activeLeafId = opts.activeLeafId ?? null
  const hasBoundLeaf = leafIds.some((leafId) => hasLeafPtyBinding(opts.ptyIdsByLeafId, leafId))

  if (
    activeLeafId &&
    leafIdSet.has(activeLeafId) &&
    (!hasBoundLeaf || hasLeafPtyBinding(opts.ptyIdsByLeafId, activeLeafId))
  ) {
    return activeLeafId
  }

  if (hasBoundLeaf) {
    return leafIds.find((leafId) => hasLeafPtyBinding(opts.ptyIdsByLeafId, leafId)) ?? null
  }

  return activeLeafId && leafIdSet.has(activeLeafId) ? activeLeafId : leafIds[0]
}

export function resolvePtyBoundActiveLeafId(args: {
  root: TerminalPaneLayoutNode | null | undefined
  activeLeafId: string | null | undefined
  ptyIdsByLeafId: Record<string, string> | null | undefined
}): string | null {
  if (!args.root) {
    return Object.keys(args.ptyIdsByLeafId ?? {})[0] ?? args.activeLeafId ?? null
  }
  return resolveTerminalLayoutActiveLeafId({
    root: args.root,
    activeLeafId: args.activeLeafId,
    ptyIdsByLeafId: args.ptyIdsByLeafId ?? undefined
  })
}
