import { relativePathInsideRoot } from '../../../../shared/cross-platform-path'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { DetectedWorktreeListResult, Worktree } from '../../../../shared/worktree/types'
import {
  callRuntimeEnvelope,
  callRuntimeResult,
  callRuntimeResultWithOwner,
  withRuntimeWorktreeOwner
} from './web-runtime-calls'
import type { WebRuntimeEnvelopeCaller, WebRuntimeResultCaller } from './web-runtime-calls'
import {
  assertActiveEnvironment,
  requireActiveEnvironment,
  webRuntimeState
} from './web-runtime-session'

export const WEB_RUNTIME_WORKTREE_LIST_LIMIT = 10_000

export async function listAllRuntimeWorktrees(): Promise<Worktree[]> {
  if (
    webRuntimeState.cachedWorktrees &&
    Date.now() - webRuntimeState.cachedWorktrees.loadedAt < 5_000
  ) {
    return webRuntimeState.cachedWorktrees.worktrees
  }
  const owned = await callRuntimeResultWithOwner<{ worktrees: Worktree[] }>('worktree.list', {
    limit: WEB_RUNTIME_WORKTREE_LIST_LIMIT
  })
  const worktrees = owned.result.worktrees.map((worktree) =>
    withRuntimeWorktreeOwner(worktree, owned.hostId)
  )
  assertActiveEnvironment(owned.environmentId)
  webRuntimeState.cachedWorktrees = { loadedAt: Date.now(), worktrees }
  return worktrees
}

export async function listAllRuntimeDetectedWorktrees(
  callResult: WebRuntimeResultCaller = callRuntimeResult,
  callEnvelope: WebRuntimeEnvelopeCaller = callRuntimeEnvelope,
  useCache = true,
  expectedEnvironmentId = requireActiveEnvironment().id
): Promise<Worktree[]> {
  if (
    useCache &&
    webRuntimeState.cachedDetectedWorktrees &&
    Date.now() - webRuntimeState.cachedDetectedWorktrees.loadedAt < 5_000
  ) {
    return webRuntimeState.cachedDetectedWorktrees.worktrees
  }

  assertActiveEnvironment(expectedEnvironmentId)
  const repos = (await callResult<{ repos: Repo[] }>('repo.list')).repos
  const detectedLists = await Promise.all(
    repos.map((repo) =>
      callRuntimeDetectedWorktrees(repo.id, expectedEnvironmentId, callResult, callEnvelope)
    )
  )
  const worktrees = detectedLists.flatMap((result) => result.worktrees)
  assertActiveEnvironment(expectedEnvironmentId)
  if (useCache) {
    webRuntimeState.cachedDetectedWorktrees = { loadedAt: Date.now(), worktrees }
  }
  return worktrees
}

export async function callRuntimeDetectedWorktrees(
  repoId: string,
  expectedEnvironmentId = requireActiveEnvironment().id,
  callResult: WebRuntimeResultCaller = callRuntimeResult,
  callEnvelope: WebRuntimeEnvelopeCaller = callRuntimeEnvelope
): Promise<DetectedWorktreeListResult> {
  assertActiveEnvironment(expectedEnvironmentId)
  const hostId = toRuntimeExecutionHostId(expectedEnvironmentId)
  const response = await callEnvelope<DetectedWorktreeListResult>(
    'worktree.detectedList',
    { repo: repoId },
    15_000
  )
  if (response.ok) {
    return {
      ...response.result,
      worktrees: response.result.worktrees.map((worktree) =>
        withRuntimeWorktreeOwner(worktree, hostId)
      )
    }
  }
  if (response.error.code !== 'method_not_found') {
    throw new Error(response.error.message)
  }

  assertActiveEnvironment(expectedEnvironmentId)
  const legacy = await callResult<{ worktrees: Worktree[] }>(
    'worktree.list',
    { repo: repoId, limit: WEB_RUNTIME_WORKTREE_LIST_LIMIT },
    15_000
  )
  return toLegacyDetectedWorktreeResult(
    repoId,
    legacy.worktrees.map((worktree) => withRuntimeWorktreeOwner(worktree, hostId))
  )
}

export function toLegacyDetectedWorktreeResult(
  repoId: string,
  worktrees: Worktree[]
): DetectedWorktreeListResult {
  return {
    repoId,
    authoritative: true,
    source: 'session-fallback',
    worktrees: worktrees.map((worktree) => ({
      ...worktree,
      ownership: 'orca-managed',
      selectedCheckout: false,
      visible: true
    }))
  }
}

export function isMissingPathError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  return /\bENOENT\b|not found|no such file/i.test(error.message)
}

export async function resolveRuntimeWorktreeByPath(
  worktreePath: string,
  callResult: WebRuntimeResultCaller = callRuntimeResult,
  callEnvelope: WebRuntimeEnvelopeCaller = callRuntimeEnvelope,
  useDetectedWorktreeCache = true,
  expectedEnvironmentId = requireActiveEnvironment().id
): Promise<Worktree> {
  // Why: hidden-but-open worktrees must still resolve, but `worktree.list` is sidebar-visible only — resolve via detected rows.
  const worktrees = await listAllRuntimeDetectedWorktrees(
    callResult,
    callEnvelope,
    useDetectedWorktreeCache,
    expectedEnvironmentId
  )
  const match = worktrees
    .map((worktree) => ({
      worktree,
      relativePath: relativePathInsideRoot(worktree.path, worktreePath)
    }))
    .filter((entry) => entry.relativePath !== null)
    .sort((a, b) => b.worktree.path.length - a.worktree.path.length)[0]
  if (!match) {
    throw new Error(`No runtime worktree owns ${worktreePath}`)
  }
  return match.worktree
}

export async function resolveRuntimeFilePath(
  filePath: string,
  preferredWorktreePath?: string,
  callResult: WebRuntimeResultCaller = callRuntimeResult,
  callEnvelope: WebRuntimeEnvelopeCaller = callRuntimeEnvelope,
  useDetectedWorktreeCache = true,
  expectedEnvironmentId = requireActiveEnvironment().id
): Promise<{ worktree: Worktree; relativePath: string }> {
  const worktree = preferredWorktreePath
    ? await resolveRuntimeWorktreeByPath(
        preferredWorktreePath,
        callResult,
        callEnvelope,
        useDetectedWorktreeCache,
        expectedEnvironmentId
      )
    : await resolveRuntimeWorktreeByPath(
        filePath,
        callResult,
        callEnvelope,
        useDetectedWorktreeCache,
        expectedEnvironmentId
      )
  const relativePath = relativePathInsideRoot(worktree.path, filePath)
  if (relativePath === null) {
    throw new Error(`File is outside runtime worktree: ${filePath}`)
  }
  return { worktree, relativePath }
}
