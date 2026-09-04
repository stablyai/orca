import type {
  PlaneComment,
  PlaneConnectArgs,
  PlaneConnectionStatus,
  PlaneCreateWorkItemResult,
  PlaneLabel,
  PlaneMember,
  PlaneMutationResult,
  PlanePriority,
  PlaneProject,
  PlaneState,
  PlaneViewer,
  PlaneWorkItem,
  PlaneWorkItemSearchResult,
  PlaneWorkItemUpdate,
  PlaneWorkspace,
  PlaneWorkspaceSelection
} from '../../../shared/plane-types'
import { PLANE_PROVIDER_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import { getPlaneRuntimeTarget, type RuntimePlaneSettings } from './runtime-plane-target'

export type { RuntimePlaneSettings } from './runtime-plane-target'

export type PlaneConnectResult =
  | { ok: true; viewer: PlaneViewer; workspace: PlaneWorkspace }
  | { ok: false; error: string }

const RPC_TIMEOUT_MS = 30_000
const CAPABILITY_TIMEOUT_MS = 30_000

/**
 * A host built before the Plane provider has no `plane.*` methods at all, so an
 * ungated call fails with method_not_found and reads as a Plane outage. Callers
 * get this instead, which the UI can explain.
 */
export class PlaneProviderUnsupportedError extends Error {
  constructor() {
    super('This remote Orca server does not support Plane yet. Update the server to connect Plane.')
    this.name = 'PlaneProviderUnsupportedError'
  }
}

type RuntimeTarget = ReturnType<typeof getPlaneRuntimeTarget>

async function assertRemoteSupport(target: RuntimeTarget): Promise<void> {
  if (target.kind !== 'environment') {
    return
  }
  const supported = await runtimeEnvironmentSupportsCapability(
    target.environmentId,
    PLANE_PROVIDER_RUNTIME_CAPABILITY,
    CAPABILITY_TIMEOUT_MS
  )
  if (!supported) {
    throw new PlaneProviderUnsupportedError()
  }
}

/** Local calls go through the preload bridge; remote ones through runtime RPC. */
async function call<TResult>(
  settings: RuntimePlaneSettings,
  method: string,
  params: unknown,
  local: () => Promise<TResult>
): Promise<TResult> {
  const target = getPlaneRuntimeTarget(settings)
  if (target.kind !== 'environment') {
    return local()
  }
  await assertRemoteSupport(target)
  return callRuntimeRpc<TResult>(target, method, params, { timeoutMs: RPC_TIMEOUT_MS })
}

export function planeStatus(settings: RuntimePlaneSettings): Promise<PlaneConnectionStatus> {
  return call(settings, 'plane.status', undefined, () => window.api.plane.status())
}

export function planeConnect(
  settings: RuntimePlaneSettings,
  args: PlaneConnectArgs
): Promise<PlaneConnectResult> {
  return call(settings, 'plane.connect', args, () => window.api.plane.connect(args))
}

export function planeDisconnect(
  settings: RuntimePlaneSettings,
  args?: { workspaceId?: string }
): Promise<{ ok: true }> {
  return call(settings, 'plane.disconnect', args, () => window.api.plane.disconnect(args))
}

export function planeSelectWorkspace(
  settings: RuntimePlaneSettings,
  workspaceId: PlaneWorkspaceSelection
): Promise<PlaneConnectionStatus> {
  return call(settings, 'plane.selectWorkspace', { workspaceId }, () =>
    window.api.plane.selectWorkspace({ workspaceId })
  )
}

export function planeTestConnection(
  settings: RuntimePlaneSettings,
  args?: { workspaceId?: string }
): Promise<{ ok: true; viewer: PlaneViewer } | { ok: false; error: string }> {
  return call(settings, 'plane.testConnection', args, () => window.api.plane.testConnection(args))
}

export function planeListProjects(
  settings: RuntimePlaneSettings,
  args?: { workspaceId?: string }
): Promise<PlaneProject[]> {
  return call(settings, 'plane.listProjects', args, () => window.api.plane.listProjects(args))
}

export function planeListStates(
  settings: RuntimePlaneSettings,
  args: { projectId: string; workspaceId?: string }
): Promise<PlaneState[]> {
  return call(settings, 'plane.listStates', args, () => window.api.plane.listStates(args))
}

export function planeListLabels(
  settings: RuntimePlaneSettings,
  args: { projectId: string; workspaceId?: string }
): Promise<PlaneLabel[]> {
  return call(settings, 'plane.listLabels', args, () => window.api.plane.listLabels(args))
}

export function planeListMembers(
  settings: RuntimePlaneSettings,
  args?: { workspaceId?: string }
): Promise<PlaneMember[]> {
  return call(settings, 'plane.listMembers', args, () => window.api.plane.listMembers(args))
}

export function planeListWorkItems(
  settings: RuntimePlaneSettings,
  args: { project: PlaneProject; workspaceId?: string; orderBy?: string; limit?: number }
): Promise<{ items: PlaneWorkItem[]; truncated: boolean }> {
  return call(settings, 'plane.listWorkItems', args, () => window.api.plane.listWorkItems(args))
}

export function planeGetWorkItem(
  settings: RuntimePlaneSettings,
  args: { key: string; workspaceId?: string; project?: PlaneProject }
): Promise<PlaneWorkItem | null> {
  return call(settings, 'plane.getWorkItem', args, () => window.api.plane.getWorkItem(args))
}

export function planeSearchWorkItems(
  settings: RuntimePlaneSettings,
  args: {
    search: string
    limit?: number
    projectId?: string
    workspaceId?: string
    requestId?: string
  }
): Promise<PlaneWorkItemSearchResult[]> {
  // requestId only cancels a local in-flight call; remote calls carry their own
  // RPC timeout and the host cancels when the socket closes.
  return call(settings, 'plane.searchWorkItems', args, () => window.api.plane.searchWorkItems(args))
}

export function planeCancelSearchWorkItems(
  settings: RuntimePlaneSettings,
  requestId: string
): Promise<void> {
  const target = getPlaneRuntimeTarget(settings)
  if (target.kind === 'environment') {
    return Promise.resolve()
  }
  return window.api.plane.cancelSearchWorkItems({ requestId })
}

export function planeWorkItemComments(
  settings: RuntimePlaneSettings,
  args: { project: PlaneProject; workItemId: string; workspaceId?: string }
): Promise<PlaneComment[]> {
  return call(settings, 'plane.workItemComments', args, () =>
    window.api.plane.workItemComments(args)
  )
}

export function planeUpdateWorkItem(
  settings: RuntimePlaneSettings,
  args: {
    project: PlaneProject
    workItemId: string
    updates: PlaneWorkItemUpdate
    workspaceId?: string
  }
): Promise<PlaneMutationResult> {
  return call(settings, 'plane.updateWorkItem', args, () => window.api.plane.updateWorkItem(args))
}

export function planeAddComment(
  settings: RuntimePlaneSettings,
  args: { project: PlaneProject; workItemId: string; body: string; workspaceId?: string }
): Promise<PlaneMutationResult> {
  return call(settings, 'plane.addComment', args, () => window.api.plane.addComment(args))
}

export function planeCreateWorkItem(
  settings: RuntimePlaneSettings,
  args: {
    project: PlaneProject
    workspaceId?: string
    title: string
    description?: string
    stateId?: string
    priority?: PlanePriority
    assigneeIds?: string[]
    labelIds?: string[]
  }
): Promise<PlaneCreateWorkItemResult> {
  return call(settings, 'plane.createWorkItem', args, () => window.api.plane.createWorkItem(args))
}
