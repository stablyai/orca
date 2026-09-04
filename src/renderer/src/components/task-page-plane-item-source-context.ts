import type { PlaneWorkItem } from '../../../shared/plane-types'
import {
  normalizeTaskSourceContext,
  type TaskSourceContext
} from '../../../shared/task-source-context'

/**
 * Binds a Plane work item to the source context stored with the workspace it
 * creates.
 *
 * Why it matters: two Plane deployments (cloud and self-hosted, or two
 * self-hosted instances) can own the same `PROJ-123`. Without the workspace and
 * project identity recorded alongside the link, a later read cannot tell which
 * connection the item came from. The item already carries both, so no extra
 * request is needed.
 */
export function bindTaskPagePlaneItemSourceContext(args: {
  item: PlaneWorkItem
  hostId: TaskSourceContext['hostId'] | null
  projectId: string | null
}): TaskSourceContext | null {
  const { item } = args
  return normalizeTaskSourceContext({
    provider: 'plane',
    // normalizeTaskSourceContext returns null without a project id, which is
    // the right outcome: no context beats a context that cannot be resolved.
    projectId: args.projectId ?? '',
    ...(args.hostId ? { hostId: args.hostId } : {}),
    providerIdentity: {
      provider: 'plane',
      workspaceId: item.workspaceId ?? null,
      workspaceSlug: null,
      projectId: item.project.id,
      projectIdentifier: item.project.identifier
    },
    accountLabel: item.workspaceName ?? null
  })
}
