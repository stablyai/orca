import { runtimeEnvironmentIdUnlessTwin } from '../../lib/resolve-owner'

/** The paired server whose tabs this workspace mirrors; an unselected twin mirrors none. */
export function mirroredRuntimeEnvironmentIdForWorkspace(
  state: Parameters<typeof runtimeEnvironmentIdUnlessTwin>[0],
  workspaceId: string | null | undefined
): string | null {
  return runtimeEnvironmentIdUnlessTwin(state, workspaceId)?.trim() || null
}
