import type { OrcadMigrationManifest } from './orcad-migration-manifest'
import { parsePtyOwnershipTransferWireIdentity } from './pty-ownership-transfer-wire'
import { parsePtyOwnershipTransferSurfaceBinding } from './pty-ownership-transfer-surface-binding'
import { parseWorkspaceKey } from './workspace-scope'

export function parseOrcadMigrationLiveTerminalBindings(
  value: unknown,
  manifest: OrcadMigrationManifest,
  conflictCode = 'orcad_migration_live_binding_conflict'
) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4096) {
    throw new Error('orcad_migration_live_bindings_invalid')
  }
  const panes = new Set<string>()
  const bridges = new Set<string>()
  const terminals = new Set<string>()
  const incarnations = new Set<string>()
  let destination: string | undefined
  return value.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('orcad_migration_live_binding_invalid')
    }
    const record = raw as Record<string, unknown>
    const identity = parsePtyOwnershipTransferWireIdentity(record.identity)
    const surfaceBinding = parsePtyOwnershipTransferSurfaceBinding(record.surfaceBinding)
    const scope = parseWorkspaceKey(surfaceBinding.workspaceKey)!
    const owner = scope.type === 'folder' ? `folder:${scope.folderWorkspaceId}` : scope.worktreeId
    const session = manifest.payload.dormantState?.workspaceSession
    const tabs = session?.tabsByWorktree[owner]?.filter((tab) => tab.id === surfaceBinding.tabId)
    const layout = session?.terminalLayoutsByTabId[surfaceBinding.tabId]
    const pane = `${surfaceBinding.tabId}:${surfaceBinding.leafId}`
    const countLeaf = (node: NonNullable<typeof layout>['root'] | undefined): number =>
      !node
        ? 0
        : node.type === 'leaf'
          ? Number(node.leafId === surfaceBinding.leafId)
          : countLeaf(node.first) + countLeaf(node.second)
    if (
      surfaceBinding.executionHostId !== 'local' ||
      surfaceBinding.ptyId !== identity.terminalId ||
      tabs?.length !== 1 ||
      tabs[0].worktreeId !== owner ||
      tabs[0].ptyId !== null ||
      countLeaf(layout?.root) !== 1 ||
      session?.terminalSurfaceTombstonesByPaneKey?.[pane] ||
      session?.sleepingAgentSessionsByPaneKey?.[pane] ||
      panes.has(pane) ||
      bridges.has(identity.bridgeId) ||
      terminals.has(identity.terminalId) ||
      incarnations.has(identity.incarnationId) ||
      (destination !== undefined && destination !== identity.destinationRuntimeId)
    ) {
      throw new Error(conflictCode)
    }
    panes.add(pane)
    bridges.add(identity.bridgeId)
    terminals.add(identity.terminalId)
    incarnations.add(identity.incarnationId)
    destination = identity.destinationRuntimeId
    return { identity, surfaceBinding }
  })
}
