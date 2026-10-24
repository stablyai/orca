import type { AppState } from '@/store/types'
import type { TabSplitTarget } from '@/store/slices/tabs/tabs-slice-contract'
import type { CreateWebRuntimeSessionBrowserTabArgs } from './web-runtime-browser-creation-context'
import { isWebRuntimeSessionActive } from './web-runtime-session-environment'

/**
 * The client group a runtime-hosted tab lands in. A requested split becomes a client-only group
 * the host never sees; runtime creation removes it again when the create fails.
 */
export function resolveWebRuntimeBrowserClientTargetGroup(
  state: Pick<AppState, 'createEmptySplitGroup'>,
  request: { workspaceId: string; targetGroupId?: string; split?: TabSplitTarget },
  environmentId: string
): Pick<
  CreateWebRuntimeSessionBrowserTabArgs,
  'targetGroupId' | 'clientTargetGroupId' | 'clientTargetGroupCreated'
> {
  const splitGroupId =
    request.split && isWebRuntimeSessionActive(environmentId)
      ? state.createEmptySplitGroup(
          request.workspaceId,
          request.split.sourceGroupId,
          request.split.splitDirection,
          { activate: false }
        )
      : null
  if (splitGroupId) {
    return { clientTargetGroupId: splitGroupId, clientTargetGroupCreated: true }
  }
  return {
    targetGroupId: request.targetGroupId,
    // Client placement survives older hosts publishing a page before the create response.
    ...(request.targetGroupId ? { clientTargetGroupId: request.targetGroupId } : {})
  }
}
