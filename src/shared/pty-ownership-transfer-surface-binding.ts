import { normalizeExecutionHostId, type ExecutionHostId } from './execution-host'
import type { WorkspaceKey } from './folder-workspace-types'
import { isTerminalLeafId } from './stable-pane-id'
import { getPtyExecutionHost } from './terminal-execution-host'
import { folderWorkspaceKey, parseWorkspaceKey, worktreeWorkspaceKey } from './workspace-scope'

const MAX_SURFACE_TAB_ID_BYTES = 512
const MAX_SURFACE_PTY_ID_BYTES = 4_096

export type PtyOwnershipTransferSurfaceBinding = Readonly<{
  executionHostId: ExecutionHostId
  workspaceKey: WorkspaceKey
  tabId: string
  leafId: string
  ptyId: string
}>

export function parsePtyOwnershipTransferSurfaceBinding(
  value: unknown
): PtyOwnershipTransferSurfaceBinding {
  if (!isRecord(value)) {
    throw new Error('pty_ownership_transfer_surface_binding_invalid')
  }
  const executionHostId = normalizeExecutionHostId(requiredString(value.executionHostId))
  const workspaceKey = requiredString(value.workspaceKey)
  const scope = parseWorkspaceKey(workspaceKey)
  const tabId = requiredString(value.tabId)
  const leafId = requiredString(value.leafId)
  const ptyId = requiredString(value.ptyId)
  const ptyExecutionHost = getPtyExecutionHost(ptyId)
  if (
    !executionHostId ||
    executionHostId !== value.executionHostId ||
    !scope ||
    canonicalWorkspaceKey(scope) !== workspaceKey ||
    tabId.includes(':') ||
    Buffer.byteLength(tabId, 'utf8') > MAX_SURFACE_TAB_ID_BYTES ||
    !isTerminalLeafId(leafId) ||
    Buffer.byteLength(ptyId, 'utf8') > MAX_SURFACE_PTY_ID_BYTES ||
    (executionHostId === 'local' ? ptyExecutionHost !== null : ptyExecutionHost !== executionHostId)
  ) {
    throw new Error('pty_ownership_transfer_surface_binding_invalid')
  }
  return Object.freeze({
    executionHostId,
    workspaceKey: workspaceKey as WorkspaceKey,
    tabId,
    leafId,
    ptyId
  })
}

export function samePtyOwnershipTransferSurfaceBinding(
  left: PtyOwnershipTransferSurfaceBinding | undefined,
  right: PtyOwnershipTransferSurfaceBinding | undefined
): boolean {
  if (!left || !right) {
    return left === right
  }
  return (
    left.executionHostId === right.executionHostId &&
    left.workspaceKey === right.workspaceKey &&
    left.tabId === right.tabId &&
    left.leafId === right.leafId &&
    left.ptyId === right.ptyId
  )
}

function canonicalWorkspaceKey(
  scope: NonNullable<ReturnType<typeof parseWorkspaceKey>>
): WorkspaceKey {
  return scope.type === 'worktree'
    ? worktreeWorkspaceKey(scope.worktreeId)
    : folderWorkspaceKey(scope.folderWorkspaceId)
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('pty_ownership_transfer_surface_binding_invalid')
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
