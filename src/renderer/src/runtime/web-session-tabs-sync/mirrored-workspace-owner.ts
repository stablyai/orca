import { runtimeEnvironmentIdForWorkspaceOwner } from '../../lib/resolve-owner'
/** The paired server whose tabs this workspace mirrors, or `null` for none. */
export function mirroredRuntimeEnvironmentIdForWorkspace(
  state: Parameters<typeof runtimeEnvironmentIdForWorkspaceOwner>[0],
  workspaceId: string | null | undefined
): string | null {
  if (!workspaceId) {
    return null
  }
  const owner = runtimeEnvironmentIdForWorkspaceOwner(state, { workspaceId })
  // Why: mirroring only reads; an unselected twin mirrors nothing until the user picks its host.
  return owner.kind === 'resolved' ? owner.environmentId?.trim() || null : null
}
