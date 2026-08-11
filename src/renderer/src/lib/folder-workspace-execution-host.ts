import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
type FolderHostOwner = { connectionId?: string | null; executionHostId?: string | null }
type FolderHostGroup = { connectionId?: string | null; executionHostId?: string | null }

function connectionHostId(connectionId: string | null): ExecutionHostId | null {
  if (connectionId === null) {
    return LOCAL_EXECUTION_HOST_ID
  }
  const targetId = connectionId.trim()
  return targetId ? toSshExecutionHostId(targetId) : null
}

function directHostConflictsWithConnection(
  hostId: ExecutionHostId,
  connectionId: string | null | undefined
): boolean {
  if (connectionId === undefined || parseExecutionHostId(hostId)?.kind === 'runtime') {
    return false
  }
  return connectionHostId(connectionId) !== hostId
}

export function resolveFolderWorkspaceExecutionHostId(args: {
  folderWorkspace: FolderHostOwner
  projectGroup?: FolderHostGroup | null
  fallbackHostId?: ExecutionHostId | null
}): ExecutionHostId | null {
  const folderHostValue = args.folderWorkspace.executionHostId
  const folderHost = parseExecutionHostId(folderHostValue)
  if (folderHostValue !== undefined && folderHostValue !== null && !folderHost) {
    return null
  }
  if (folderHost) {
    return directHostConflictsWithConnection(folderHost.id, args.folderWorkspace.connectionId)
      ? null
      : folderHost.id
  }

  const groupHostValue = args.projectGroup?.executionHostId
  const groupHost = parseExecutionHostId(groupHostValue)
  if (groupHostValue !== undefined && groupHostValue !== null && !groupHost) {
    return null
  }
  // Runtime is the transport owner even when the folder carries source-host provenance.
  if (groupHost?.kind === 'runtime') {
    return groupHost.id
  }

  if (args.folderWorkspace.connectionId !== undefined) {
    return connectionHostId(args.folderWorkspace.connectionId)
  }
  if (groupHost) {
    return directHostConflictsWithConnection(groupHost.id, args.projectGroup?.connectionId)
      ? null
      : groupHost.id
  }
  if (args.projectGroup?.connectionId !== undefined) {
    return connectionHostId(args.projectGroup.connectionId)
  }
  return args.fallbackHostId ?? null
}
