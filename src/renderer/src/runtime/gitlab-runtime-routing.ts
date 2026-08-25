import { parseExecutionHostId } from '../../../shared/execution-host'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { callRuntimeRpc } from './runtime-rpc-client'

// Why: GitLab list fetches page issues/MRs through glab, longer than a point
// mutation; match the GitHub work-item list timeout rather than a shorter default.
const RUNTIME_RPC_TIMEOUT_MS = 30_000

type GitLabSelectorArgs = {
  repoPath?: string | null
  repoId?: string | null
  sourceContext?: TaskSourceContext | null
}

type GL = typeof window.api.gl

export type GitLabTaskRuntimeTarget =
  | { kind: 'local' }
  | { kind: 'environment'; environmentId: string; repoSelector: string }

// Why: a GitLab repo owned by a remote runtime host must relay every task
// operation to that host over RPC, not hit the local IPC handler. The local
// handler runs assertRegisteredRepo, which rejects any path not registered in
// this machine's own repo store with "Access denied: unknown repository path";
// a runtime-owned repo only exists in the owning host's store. Route by the
// repo's own execution host (sourceContext.hostId), not the Active Server
// dropdown, so a runtime-owned repo resolves even while Local is focused.
export function getGitLabTaskRuntimeTarget(args: GitLabSelectorArgs): GitLabTaskRuntimeTarget {
  if (args.sourceContext?.provider !== 'gitlab') {
    return { kind: 'local' }
  }
  const parsedHost = parseExecutionHostId(args.sourceContext.hostId)
  if (parsedHost?.kind !== 'runtime') {
    return { kind: 'local' }
  }
  // Why: the runtime host resolves this against its own repo store; the
  // renderer preserves the owning host's repo id, so an explicit `id:` selector
  // is unambiguous where a bare path could collide with a duplicate checkout.
  const repoId = args.sourceContext.repoId ?? args.repoId ?? null
  if (!repoId) {
    return { kind: 'local' }
  }
  return {
    kind: 'environment',
    environmentId: parsedHost.environmentId,
    repoSelector: `id:${repoId}`
  }
}

function toRpcParams(
  args: GitLabSelectorArgs,
  repoSelector: string,
  extra?: Record<string, unknown>
): Record<string, unknown> {
  const params = { ...args } as Record<string, unknown>
  // Why: the RPC selector replaces the IPC path/id/context fields with a single `repo`.
  Reflect.deleteProperty(params, 'repoPath')
  Reflect.deleteProperty(params, 'repoId')
  Reflect.deleteProperty(params, 'sourceContext')
  if (extra) {
    Object.assign(params, extra)
  }
  params.repo = repoSelector
  return params
}

// Why: window.api.gl.* runs glab in main with no subprocess timeout, so an
// unreachable GitLab host would leave the UI spinning forever. Bound the local
// branch the way callRuntimeRpc bounds the remote one. Rejects only the pending
// promise — the main-process call is not cancellable from here, but this is
// enough to surface an error instead of a stuck spinner.
function withTimeout<T>(pending: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    pending,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('GitLab request timed out')), timeoutMs)
    })
  ]).finally(() => {
    clearTimeout(timer)
  })
}

function dispatch<A extends GitLabSelectorArgs, R>(
  localCall: (args: A) => Promise<R>,
  rpcMethod: string,
  args: A,
  extra?: Record<string, unknown>
): Promise<R> {
  const target = getGitLabTaskRuntimeTarget(args)
  if (target.kind === 'local') {
    return withTimeout(localCall(args), RUNTIME_RPC_TIMEOUT_MS)
  }
  return callRuntimeRpc<R>(
    { kind: 'environment', environmentId: target.environmentId },
    rpcMethod,
    toRpcParams(args, target.repoSelector, extra),
    { timeoutMs: RUNTIME_RPC_TIMEOUT_MS }
  )
}

// Why: mirror the host method names the web client already routes to
// (GITLAB_WEB_RPC_METHODS) and the host registers (rpc/methods/gitlab.ts). A
// drift here surfaces as "works over the web/mobile client, broken on desktop".
const RPC = {
  listIssues: 'gitlab.listIssues',
  listMRs: 'gitlab.listMRs',
  todos: 'gitlab.todos',
  workItemDetails: 'gitlab.workItemDetails',
  listLabels: 'gitlab.listLabels',
  updateMR: 'gitlab.updateMR',
  jobTrace: 'gitlab.jobTrace',
  retryJob: 'gitlab.retryJob',
  updateMRReviewers: 'gitlab.updateMRReviewers',
  addMRInlineComment: 'gitlab.addMRInlineComment',
  updateMRState: 'gitlab.updateMRState',
  mergeMR: 'gitlab.mergeMR',
  addMRComment: 'gitlab.addMRComment',
  addIssueComment: 'gitlab.addIssueComment',
  resolveMRDiscussion: 'gitlab.resolveMRDiscussion'
} as const

/**
 * Drop-in replacement for `window.api.gl` across the GitLab Tasks surface.
 *
 * Each method keeps the local IPC signature, but a repo owned by a remote
 * runtime host relays to that host over RPC instead of failing the local
 * repo-path guard. Only the methods the Tasks list and item dialog use are
 * routed here; already-routed call sites (ChecksPanel, the URL picker, job-log
 * details) keep their own target checks.
 */
export const routedGitLab = {
  listIssues: (args: Parameters<GL['listIssues']>[0]) =>
    dispatch(window.api.gl.listIssues, RPC.listIssues, args),
  listMRs: (args: Parameters<GL['listMRs']>[0]) =>
    dispatch(window.api.gl.listMRs, RPC.listMRs, args),
  todos: (args: Parameters<GL['todos']>[0]) => dispatch(window.api.gl.todos, RPC.todos, args),
  workItemDetails: (args: Parameters<GL['workItemDetails']>[0]) =>
    dispatch(window.api.gl.workItemDetails, RPC.workItemDetails, args),
  listLabels: (args: Parameters<GL['listLabels']>[0]) =>
    dispatch(window.api.gl.listLabels, RPC.listLabels, args),
  // Why: the host exposes no gitlab.listAssignableUsers RPC (the web client
  // returns [] too); degrade to an empty picker for remote repos rather than error.
  listAssignableUsers: (
    args: Parameters<GL['listAssignableUsers']>[0]
  ): ReturnType<GL['listAssignableUsers']> =>
    getGitLabTaskRuntimeTarget(args).kind === 'environment'
      ? (Promise.resolve([]) as ReturnType<GL['listAssignableUsers']>)
      : window.api.gl.listAssignableUsers(args),
  updateMR: (args: Parameters<GL['updateMR']>[0]) =>
    dispatch(window.api.gl.updateMR, RPC.updateMR, args),
  // Why: raw CI traces routinely exceed the runtime RPC frame cap, so ask the
  // host to bound the log before it crosses the wire. `extra` is merged into the
  // RPC params only, so the local path keeps the full trace — matching
  // gitlab-job-trace-client's remote-excerpt / local-full split.
  jobTrace: (args: Parameters<GL['jobTrace']>[0]) =>
    dispatch(window.api.gl.jobTrace, RPC.jobTrace, args, { logExcerpt: true }),
  retryJob: (args: Parameters<GL['retryJob']>[0]) =>
    dispatch(window.api.gl.retryJob, RPC.retryJob, args),
  updateMRReviewers: (args: Parameters<GL['updateMRReviewers']>[0]) =>
    dispatch(window.api.gl.updateMRReviewers, RPC.updateMRReviewers, args),
  addMRInlineComment: (args: Parameters<GL['addMRInlineComment']>[0]) =>
    dispatch(window.api.gl.addMRInlineComment, RPC.addMRInlineComment, args),
  // Why: close/reopen are one host method (updateMRState) keyed by state; the
  // local IPC keeps separate channels, so inject the state on the RPC path only.
  closeMR: (args: Parameters<GL['closeMR']>[0]) =>
    dispatch(window.api.gl.closeMR, RPC.updateMRState, args, { state: 'closed' }),
  reopenMR: (args: Parameters<GL['reopenMR']>[0]) =>
    dispatch(window.api.gl.reopenMR, RPC.updateMRState, args, { state: 'opened' }),
  mergeMR: (args: Parameters<GL['mergeMR']>[0]) =>
    dispatch(window.api.gl.mergeMR, RPC.mergeMR, args),
  addMRComment: (args: Parameters<GL['addMRComment']>[0]) =>
    dispatch(window.api.gl.addMRComment, RPC.addMRComment, args),
  addIssueComment: (args: Parameters<GL['addIssueComment']>[0]) =>
    dispatch(window.api.gl.addIssueComment, RPC.addIssueComment, args),
  resolveMRDiscussion: (args: Parameters<GL['resolveMRDiscussion']>[0]) =>
    dispatch(window.api.gl.resolveMRDiscussion, RPC.resolveMRDiscussion, args)
}
