import type { ItsaplanApi } from '../../../../preload/api/work-items/itsaplan-api'
import { rowLessSourceTarget } from '../hosts/selection/default-creation-host'
import type { RowLessSource as RuntimeItsaplanSettings } from '../hosts/selection/default-creation-host'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { callRuntimeRpc } from '../rpc/calls/runtime-rpc-call'

const REQUEST_TIMEOUT_MS = 30_000
const ADMIN_TIMEOUT_MS = 15_000

export function createRuntimeItsaplanClient(settings: RuntimeItsaplanSettings): ItsaplanApi {
  return createItsaplanClientForTarget(rowLessSourceTarget(settings))
}

export function createItsaplanClientForTarget(target: RuntimeClientTarget): ItsaplanApi {
  const route = <T>(
    method: keyof ItsaplanApi,
    args: unknown,
    local: () => Promise<T>,
    timeoutMs = REQUEST_TIMEOUT_MS
  ): Promise<T> =>
    target.kind === 'environment'
      ? callRuntimeRpc<T>(target, `itsaplan.${method}`, args, { timeoutMs })
      : local()
  const api = () => window.api.itsaplan

  return {
    detectApiUrl: (args) => route('detectApiUrl', args, () => api().detectApiUrl(args)),
    connect: (args) => route('connect', args, () => api().connect(args)),
    disconnect: async () => {
      await route('disconnect', undefined, () => api().disconnect(), ADMIN_TIMEOUT_MS)
    },
    status: () => route('status', undefined, () => api().status(), ADMIN_TIMEOUT_MS),
    testConnection: () => route('testConnection', undefined, () => api().testConnection()),
    listProjects: (args) => route('listProjects', args, () => api().listProjects(args)),
    getProjectMetadata: (args) =>
      route('getProjectMetadata', args, () => api().getProjectMetadata(args)),
    listIssues: (args) => route('listIssues', args, () => api().listIssues(args)),
    getIssue: (args) => route('getIssue', args, () => api().getIssue(args)),
    createIssue: (args) => route('createIssue', args, () => api().createIssue(args)),
    updateIssue: (args) => route('updateIssue', args, () => api().updateIssue(args)),
    addComment: (args) => route('addComment', args, () => api().addComment(args))
  }
}
