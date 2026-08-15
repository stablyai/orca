import type { GlobalSettings } from '../../../shared/global-settings-types'
import type {
  PlaneCollectionResult,
  PlaneComment,
  PlaneConnectArgs,
  PlaneConnectionStatus,
  PlaneCreateIssueArgs,
  PlaneCycle,
  PlaneEstimate,
  PlaneIssueAttachment,
  PlaneIssueLink,
  PlaneIssueUpdate,
  PlaneLabel,
  PlaneListFilter,
  PlaneMember,
  PlaneModule,
  PlaneProject,
  PlaneState,
  PlaneViewer,
  PlaneWorkItemType,
  PlaneWorkItem
} from '../../../shared/plane/types'
import { callRuntimeRpc, getActiveRuntimeTarget } from './runtime-rpc-client'
import {
  getTaskSourceRuntimeSettings,
  type TaskSourceContext
} from '../../../shared/task-source-context'

export type RuntimePlaneSettings =
  | Pick<GlobalSettings, 'activeRuntimeEnvironmentId'>
  | TaskSourceContext
  | null
  | undefined
type PlaneConnectResult = { ok: true; viewer: PlaneViewer } | { ok: false; error: string }
type PlaneMutationResult = { ok: true } | { ok: false; error: string }
const PLANE_LOCAL_TIMEOUT_MS = 30_000

function target(settings: RuntimePlaneSettings): ReturnType<typeof getActiveRuntimeTarget> {
  return getActiveRuntimeTarget(
    settings && 'kind' in settings ? getTaskSourceRuntimeSettings(settings) : settings
  )
}

async function planeCall<T>(
  settings: RuntimePlaneSettings,
  method: string,
  params?: unknown
): Promise<T> {
  const active = target(settings)
  return active.kind === 'environment'
    ? callRuntimeRpc<T>(active, method, params, { timeoutMs: 30_000 })
    : withTimeout(localCall<T>(method, params), method)
}

function withTimeout<T>(promise: Promise<T>, method: string): Promise<T> {
  let timeout: number | null = null
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = window.setTimeout(
      () => reject(new Error(`${method} timed out`)),
      PLANE_LOCAL_TIMEOUT_MS
    )
  })
  return Promise.race([promise, deadline]).finally(() => {
    if (timeout) {
      window.clearTimeout(timeout)
    }
  })
}

async function localCall<T>(method: string, params?: unknown): Promise<T> {
  const api = window.api.plane
  switch (method) {
    case 'plane.connect':
      return api.connect(params as PlaneConnectArgs) as Promise<T>
    case 'plane.disconnect':
      return api.disconnect(params as { instanceId?: string } | undefined) as Promise<T>
    case 'plane.selectInstance':
      return api.selectInstance(params as { instanceId: string }) as Promise<T>
    case 'plane.status':
      return api.status() as Promise<T>
    case 'plane.testConnection':
      return api.testConnection(params as { instanceId?: string } | undefined) as Promise<T>
    case 'plane.listProjects':
      return api.listProjects(params as { instanceId?: string } | undefined) as Promise<T>
    case 'plane.listStates':
      return api.listStates(params as { projectId: string; instanceId?: string }) as Promise<T>
    case 'plane.listLabels':
      return api.listLabels(params as { projectId: string; instanceId?: string }) as Promise<T>
    case 'plane.listMembers':
      return api.listMembers(params as { instanceId?: string } | undefined) as Promise<T>
    case 'plane.listCycles':
      return api.listCycles(params as { projectId: string; instanceId?: string }) as Promise<T>
    case 'plane.listModules':
      return api.listModules(params as { projectId: string; instanceId?: string }) as Promise<T>
    case 'plane.listWorkItemTypes':
      return api.listWorkItemTypes(
        params as { projectId: string; instanceId?: string }
      ) as Promise<T>
    case 'plane.listEstimates':
      return api.listEstimates(params as { projectId: string; instanceId?: string }) as Promise<T>
    case 'plane.searchIssues':
      return api.searchIssues(
        params as { query: string; limit?: number; instanceId?: string }
      ) as Promise<T>
    case 'plane.listIssues':
      return api.listIssues(
        params as { filter?: 'all'; limit?: number; instanceId?: string } | undefined
      ) as Promise<T>
    case 'plane.getIssue':
      return api.getIssue(params as { id: string; instanceId?: string }) as Promise<T>
    case 'plane.createIssue':
      return api.createIssue(params as PlaneCreateIssueArgs) as Promise<T>
    case 'plane.updateIssue':
      return api.updateIssue(
        params as { id: string; updates: PlaneIssueUpdate; instanceId?: string }
      ) as Promise<T>
    case 'plane.deleteIssue':
      return api.deleteIssue(params as { id: string; instanceId?: string }) as Promise<T>
    case 'plane.addIssueComment':
      return api.addIssueComment(
        params as { id: string; body: string; instanceId?: string }
      ) as Promise<T>
    case 'plane.issueComments':
      return api.issueComments(params as { id: string; instanceId?: string }) as Promise<T>
    case 'plane.issueLinks':
      return api.issueLinks(params as { id: string; instanceId?: string }) as Promise<T>
    case 'plane.addIssueLink':
      return api.addIssueLink(
        params as { id: string; title: string; url: string; instanceId?: string }
      ) as Promise<T>
    case 'plane.issueAttachments':
      return api.issueAttachments(params as { id: string; instanceId?: string }) as Promise<T>
    default:
      throw new Error(`Unknown Plane method: ${method}`)
  }
}

export const planeStatus = (settings: RuntimePlaneSettings): Promise<PlaneConnectionStatus> =>
  planeCall(settings, 'plane.status')
export const planeConnect = (
  settings: RuntimePlaneSettings,
  args: PlaneConnectArgs
): Promise<PlaneConnectResult> => planeCall(settings, 'plane.connect', args)
export const planeDisconnect = (
  settings: RuntimePlaneSettings,
  instanceId?: string
): Promise<void> => planeCall(settings, 'plane.disconnect', instanceId ? { instanceId } : undefined)
export const planeTestConnection = (
  settings: RuntimePlaneSettings,
  instanceId?: string
): Promise<PlaneConnectResult> =>
  planeCall(settings, 'plane.testConnection', instanceId ? { instanceId } : undefined)
export const planeListProjects = (
  settings: RuntimePlaneSettings,
  instanceId?: string
): Promise<PlaneProject[]> =>
  planeCall(settings, 'plane.listProjects', instanceId ? { instanceId } : undefined)
export const planeListStates = (
  settings: RuntimePlaneSettings,
  projectId: string,
  instanceId?: string
): Promise<PlaneState[]> => planeCall(settings, 'plane.listStates', { projectId, instanceId })
export const planeListLabels = (
  settings: RuntimePlaneSettings,
  projectId: string,
  instanceId?: string
): Promise<PlaneLabel[]> => planeCall(settings, 'plane.listLabels', { projectId, instanceId })
export const planeListMembers = (
  settings: RuntimePlaneSettings,
  instanceId?: string
): Promise<PlaneMember[]> =>
  planeCall(settings, 'plane.listMembers', instanceId ? { instanceId } : undefined)
export const planeListCycles = (
  settings: RuntimePlaneSettings,
  projectId: string,
  instanceId?: string
): Promise<PlaneCycle[]> => planeCall(settings, 'plane.listCycles', { projectId, instanceId })
export const planeListModules = (
  settings: RuntimePlaneSettings,
  projectId: string,
  instanceId?: string
): Promise<PlaneModule[]> => planeCall(settings, 'plane.listModules', { projectId, instanceId })
export const planeListWorkItemTypes = (
  settings: RuntimePlaneSettings,
  projectId: string,
  instanceId?: string
): Promise<PlaneWorkItemType[]> =>
  planeCall(settings, 'plane.listWorkItemTypes', { projectId, instanceId })
export const planeListEstimates = (
  settings: RuntimePlaneSettings,
  projectId: string,
  instanceId?: string
): Promise<PlaneEstimate[]> => planeCall(settings, 'plane.listEstimates', { projectId, instanceId })
export const planeSearchIssues = (
  settings: RuntimePlaneSettings,
  query: string,
  limit?: number,
  instanceId?: string
): Promise<PlaneWorkItem[]> =>
  planeCall(settings, 'plane.searchIssues', { query, limit, instanceId })
export const planeListIssues = (
  settings: RuntimePlaneSettings,
  filter?: PlaneListFilter,
  limit?: number,
  instanceId?: string
): Promise<PlaneCollectionResult<PlaneWorkItem>> =>
  planeCall(settings, 'plane.listIssues', { filter, limit, instanceId })
export const planeGetIssue = (
  settings: RuntimePlaneSettings,
  id: string,
  instanceId?: string
): Promise<PlaneWorkItem | null> => planeCall(settings, 'plane.getIssue', { id, instanceId })
export const planeCreateIssue = (
  settings: RuntimePlaneSettings,
  args: PlaneCreateIssueArgs
): Promise<
  | { ok: true; id: string; identifier: string; title: string; url: string }
  | { ok: false; error: string }
> => planeCall(settings, 'plane.createIssue', args)
export const planeUpdateIssue = (
  settings: RuntimePlaneSettings,
  id: string,
  updates: PlaneIssueUpdate,
  instanceId?: string
): Promise<PlaneMutationResult> =>
  planeCall(settings, 'plane.updateIssue', { id, updates, instanceId })
export const planeDeleteIssue = (
  settings: RuntimePlaneSettings,
  id: string,
  instanceId?: string
): Promise<PlaneMutationResult> => planeCall(settings, 'plane.deleteIssue', { id, instanceId })
export const planeAddIssueComment = (
  settings: RuntimePlaneSettings,
  id: string,
  body: string,
  instanceId?: string
): Promise<{ ok: true; id: string } | { ok: false; error: string }> =>
  planeCall(settings, 'plane.addIssueComment', { id, body, instanceId })
export const planeIssueComments = (
  settings: RuntimePlaneSettings,
  id: string,
  instanceId?: string
): Promise<PlaneComment[]> => planeCall(settings, 'plane.issueComments', { id, instanceId })
export const planeIssueLinks = (
  settings: RuntimePlaneSettings,
  id: string,
  instanceId?: string
): Promise<PlaneIssueLink[]> => planeCall(settings, 'plane.issueLinks', { id, instanceId })
export const planeAddIssueLink = (
  settings: RuntimePlaneSettings,
  id: string,
  title: string,
  url: string,
  instanceId?: string
): Promise<{ ok: true; id: string } | { ok: false; error: string }> =>
  planeCall(settings, 'plane.addIssueLink', { id, title, url, instanceId })
export const planeIssueAttachments = (
  settings: RuntimePlaneSettings,
  id: string,
  instanceId?: string
): Promise<PlaneIssueAttachment[]> =>
  planeCall(settings, 'plane.issueAttachments', { id, instanceId })
