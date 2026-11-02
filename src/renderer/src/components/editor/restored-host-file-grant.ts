import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  hostSavesGrantedFiles,
  renewTerminalArtifactGrant
} from '@/runtime/runtime-terminal-artifact-grant'

export const REMOTE_EXTERNAL_FILE_UNAVAILABLE_MESSAGE =
  'External local files are not available for remote workspaces.'

/** Grants are never persisted, so a restored host file outside every workspace asks its host again. */
export async function grantRestoredHostFile(
  target: RuntimeClientTarget,
  worktreeId: string | null | undefined,
  filePath: string,
  expectedEnvironmentPairingRevision?: number
): Promise<{ grantId: string; readOnly: boolean }> {
  if (target.kind !== 'environment' || !worktreeId) {
    throw new Error(REMOTE_EXTERNAL_FILE_UNAVAILABLE_MESSAGE)
  }
  const renewed = await renewTerminalArtifactGrant({
    target,
    worktreeId,
    absolutePath: filePath,
    expectedEnvironmentPairingRevision
  })
  if (!renewed) {
    throw new Error(REMOTE_EXTERNAL_FILE_UNAVAILABLE_MESSAGE)
  }
  return {
    grantId: renewed.grantId,
    // Why: match a fresh open, which stays read-only where the host can't renew grants.
    readOnly: renewed.readOnly || !(await hostSavesGrantedFiles(target.environmentId))
  }
}
