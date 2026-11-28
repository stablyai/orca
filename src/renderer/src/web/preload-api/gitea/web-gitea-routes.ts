import type { GiteaApi } from '../../../../../preload/api/gitea/gitea-api'

/** The runtime RPC method that serves each `gitea` preload call. */
export const GITEA_WEB_RPC_METHODS = {
  connect: 'gitea.connect',
  disconnect: 'gitea.disconnect',
  status: 'gitea.status',
  testConnection: 'gitea.testConnection',
  listWorkItems: 'gitea.listWorkItems',
  issue: 'gitea.issue',
  issueComments: 'gitea.issueComments',
  labels: 'gitea.labels',
  assignees: 'gitea.assignees',
  createIssue: 'gitea.createIssue',
  updateIssue: 'gitea.updateIssue',
  addIssueComment: 'gitea.addIssueComment',
  prDetail: 'gitea.prDetail',
  prFiles: 'gitea.prFiles',
  prFileContents: 'gitea.prFileContents',
  prChecks: 'gitea.prChecks',
  prMerge: 'gitea.prMerge',
  prReviewComments: 'gitea.prReviewComments',
  prAddReviewComment: 'gitea.prAddReviewComment'
} as const satisfies Record<keyof GiteaApi, `gitea.${string}`>

export type WebGiteaRuntimeMethod = (typeof GITEA_WEB_RPC_METHODS)[keyof GiteaApi]
