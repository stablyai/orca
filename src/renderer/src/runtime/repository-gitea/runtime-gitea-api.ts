import type { GiteaApi } from '../../../../preload/api/gitea/gitea-api'
import {
  GITEA_WEB_RPC_METHODS,
  type WebGiteaRuntimeMethod
} from '@/web/preload-api/gitea/web-gitea-routes'
import { mapRepoPathArg } from '../source-control/forge/runtime-repo-selector-params'

export type RuntimeGiteaCall = <Result>(
  method: WebGiteaRuntimeMethod,
  params?: unknown
) => Promise<Result>

type Result<K extends keyof GiteaApi> = Awaited<ReturnType<GiteaApi[K]>>

/** The `gitea` preload API spoken over runtime RPC to the server that owns the repo. */
export function createRuntimeGiteaApi(call: RuntimeGiteaCall): GiteaApi {
  const route =
    <K extends keyof GiteaApi>(key: K) =>
    (args?: unknown): Promise<Result<K>> =>
      call<Result<K>>(GITEA_WEB_RPC_METHODS[key], mapRepoPathArg(args))
  return {
    connect: route('connect'),
    disconnect: route('disconnect'),
    selectServer: route('selectServer'),
    status: route('status'),
    testConnection: route('testConnection'),
    listWorkItems: route('listWorkItems'),
    issue: route('issue'),
    issueComments: route('issueComments'),
    labels: route('labels'),
    assignees: route('assignees'),
    createIssue: route('createIssue'),
    updateIssue: route('updateIssue'),
    addIssueComment: route('addIssueComment'),
    prDetail: route('prDetail'),
    prFiles: route('prFiles'),
    prFileContents: route('prFileContents'),
    prChecks: route('prChecks'),
    prMerge: route('prMerge'),
    prReviewComments: route('prReviewComments'),
    prAddReviewComment: route('prAddReviewComment')
  }
}
