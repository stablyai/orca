import { sshArtifactSourceKey } from '../../../shared/artifact-cli-bridge'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'

/** The host a shared file is read from. */
export type FileArtifactOwner = {
  /** Null when the host route never resolved; the key then names only the environment. */
  executionHostId: ExecutionHostId | null
  runtimeEnvironmentId: string | null
  externalSshTargetId?: string | null
}

/** Windows drive and UNC paths spell with backslashes, whichever slash the caller had. */
export function canonicalArtifactFilePath(filePath: string): string {
  return /^[A-Za-z]:[\\/]/.test(filePath) || /^[\\/]{2}/.test(filePath)
    ? filePath.replaceAll('/', '\\')
    : filePath
}

/**
 * One published link per file per host, whichever surface shares it: the editor, a rendered
 * preview, a browser tab, or the CLI. SSH keys match the CLI's.
 */
export function fileArtifactSourceKey(owner: FileArtifactOwner, filePath: string): string {
  const path = canonicalArtifactFilePath(filePath)
  const host = parseExecutionHostId(owner.executionHostId)
  if (host?.kind === 'ssh') {
    return sshArtifactSourceKey(host.targetId, path)
  }
  if (owner.externalSshTargetId) {
    return sshArtifactSourceKey(owner.externalSshTargetId, path)
  }
  if (owner.runtimeEnvironmentId || (owner.executionHostId && owner.executionHostId !== 'local')) {
    return JSON.stringify([
      'editor',
      owner.runtimeEnvironmentId,
      owner.executionHostId ?? 'remote',
      path
    ])
  }
  return path
}

export const LOCAL_FILE_ARTIFACT_OWNER: FileArtifactOwner = {
  executionHostId: 'local',
  runtimeEnvironmentId: null
}
