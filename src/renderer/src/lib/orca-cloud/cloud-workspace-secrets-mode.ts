// SEC-5: a cloud workspace shared with teammates gets no personal secrets (its owner's or anyone's).
// What a workspace-scoped secrets view should answer for: the shared mode drops personal values.
import type { CloudSecretWorkspaceMode } from '../../../../shared/cloud-secrets/cloud-secrets-wire'

/**
 * 'shared' when the workspace is shared, or when its sharing can't be read (fails closed, like D13):
 * promising a personal value that the workspace won't get is the mismatch SEC-5 removes.
 * No runtime environment (a workspace still being created, or none known): 'private'.
 */
export async function cloudWorkspaceSecretsMode(
  runtimeEnvironmentId: string | null
): Promise<CloudSecretWorkspaceMode> {
  const secrets = window.api.cloudSecrets
  if (!runtimeEnvironmentId || !secrets) {
    return 'private'
  }
  let sharing: Awaited<ReturnType<typeof secrets.workspaceSharing>> | null = null
  try {
    sharing = await secrets.workspaceSharing({ runtimeEnvironmentId })
  } catch {
    sharing = null
  }
  return sharing?.ok && !sharing.value.shared ? 'private' : 'shared'
}
