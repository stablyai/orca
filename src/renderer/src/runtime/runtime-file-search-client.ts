import { createBrowserUuid } from '@/lib/browser-uuid'
import { throwIfSignalAborted, waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import type { SearchOptions, SearchResult } from '../../../shared/code-search-types'
import type { RuntimeFileListResult } from '../../../shared/runtime-types'
import {
  buildExcludePathPrefixes,
  shouldExcludeQuickOpenRelPath
} from '../../../shared/quick-open-filter'
import type { RuntimeFileOperationArgs } from './runtime-file-client-types'
import {
  createEmptyRuntimeFileSearchResult,
  getRuntimeFileSearchRejectedField
} from './runtime-file-search-bounds'
import {
  hasCachedLegacyQuickOpenInventory,
  searchLegacyQuickOpenInventory,
  validateLegacyQuickOpenRecentCandidates
} from './runtime-legacy-quick-open-inventory'
import { callRuntimeRpc, getActiveRuntimeTarget, RuntimeRpcCallError } from './runtime-rpc-client'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'

const QUICK_OPEN_REMOTE_UPDATE_REQUIRED_MESSAGE =
  'Quick Open search requires a newer paired Orca host. Update the remote host and reconnect.'

export async function searchRuntimeFiles(
  context: RuntimeFileOperationArgs,
  options: SearchOptions,
  signal?: AbortSignal
): Promise<SearchResult> {
  throwIfSignalAborted(signal)
  if (getRuntimeFileSearchRejectedField(options)) {
    return createEmptyRuntimeFileSearchResult()
  }
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind !== 'environment' || !context.worktreeId) {
    const requestToken = createBrowserUuid()
    const cancel = (): void => {
      void window.api.fs.cancelSearch({ requestToken }).catch(() => undefined)
    }
    const request = window.api.fs.search({
      ...options,
      connectionId: context.connectionId,
      requestToken
    })
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      if (signal?.aborted) {
        cancel()
      }
      return await waitForPromiseWithSignal(request, signal)
    } finally {
      signal?.removeEventListener('abort', cancel)
    }
  }
  const { rootPath: _rootPath, ...runtimeOptions } = options
  return callRuntimeRpc<SearchResult>(
    target,
    'files.search',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), ...runtimeOptions },
    { timeoutMs: 15_000, signal }
  )
}

export async function listRuntimeFiles(
  context: RuntimeFileOperationArgs,
  args: {
    rootPath: string
    candidatePaths?: string[]
    includeIgnored?: boolean
    allowLegacyIncludeIgnored?: boolean
    followSymlinks?: boolean
    excludePaths?: string[]
    requestToken?: string
    // Why: naming the cap is what makes a full page readable as "there is more". The host returns
    // the whole listing when no limit is named, so a caller that never states one cannot tell a
    // bound from a total.
    maxResults?: number
    /** Local hosts only; SSH and runtime hosts list unfiltered. */
    nameFilter?: string
    signal?: AbortSignal
  }
): Promise<string[]> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind !== 'environment' || !context.worktreeId) {
    return window.api.fs.listFiles({
      ...(args.includeIgnored === undefined ? {} : { includeIgnored: args.includeIgnored }),
      ...(args.followSymlinks === undefined ? {} : { followSymlinks: args.followSymlinks }),
      ...(args.allowLegacyIncludeIgnored ? { allowLegacyIncludeIgnored: true } : {}),
      rootPath: args.rootPath,
      ...(args.candidatePaths === undefined ? {} : { candidatePaths: args.candidatePaths }),
      connectionId: context.connectionId,
      excludePaths: args.excludePaths,
      requestToken: args.requestToken,
      ...(args.maxResults === undefined ? {} : { maxResults: args.maxResults }),
      ...(args.nameFilter && !context.connectionId ? { nameFilter: args.nameFilter } : {})
    })
  }
  let includeIgnored = args.includeIgnored
  if (includeIgnored === false || args.followSymlinks || args.candidatePaths !== undefined) {
    const capability = await callRuntimeRpc<RuntimeFileListResult>(
      target,
      'files.searchPaths',
      {
        worktree: toRuntimeWorktreeSelector(context.worktreeId),
        query: '',
        limit: 1,
        mode: 'quick-open'
      },
      { timeoutMs: 5_000, signal: args.signal }
    ).catch((error: unknown) => {
      if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
        return null
      }
      throw error
    })
    if (
      includeIgnored === false &&
      args.allowLegacyIncludeIgnored &&
      (capability?.quickOpenSearchVersion ?? 0) < 2
    ) {
      includeIgnored = undefined
    }
    if (
      !(
        typeof capability?.quickOpenSearchVersion === 'number' &&
        capability.quickOpenSearchVersion >= (args.candidatePaths === undefined ? 2 : 3)
      )
    ) {
      if (args.candidatePaths !== undefined && includeIgnored !== false && !args.followSymlinks) {
        return validateLegacyQuickOpenRecentCandidates({
          target,
          worktreeSelector: toRuntimeWorktreeSelector(context.worktreeId),
          worktreePath: context.worktreePath,
          excludePaths: args.excludePaths,
          candidatePaths: args.candidatePaths,
          signal: args.signal
        })
      }
      if (includeIgnored === false || args.followSymlinks) {
        throw new Error('Update the remote host to use Quick Open listing options.')
      }
    }
  }
  return callRuntimeRpc<string[]>(
    target,
    'files.listAll',
    {
      worktree: toRuntimeWorktreeSelector(context.worktreeId),
      ...(args.candidatePaths === undefined ? {} : { candidatePaths: args.candidatePaths }),
      ...(includeIgnored === undefined ? {} : { includeIgnored }),
      ...(args.followSymlinks === undefined ? {} : { followSymlinks: args.followSymlinks }),
      excludePaths: args.excludePaths,
      // Optional on the host schema since #17954; an older host strips it and keeps its own default.
      ...(args.maxResults === undefined ? {} : { maxResults: args.maxResults })
    },
    { timeoutMs: 15_000, ...(args.signal === undefined ? {} : { signal: args.signal }) }
  )
}

export async function searchRuntimeFilePaths(
  context: RuntimeFileOperationArgs,
  args: {
    query: string
    limit?: number
    includeIgnored?: boolean
    allowLegacyIncludeIgnored?: boolean
    followSymlinks?: boolean
    excludePaths?: string[]
    requestToken?: string
    signal?: AbortSignal
  }
): Promise<{ files: string[]; truncated: boolean }> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind !== 'environment') {
    // Local roots reach here only after fs.rankedPathSearch said an index ranks them.
    if (!context.worktreePath) {
      return { files: [], truncated: false }
    }
    const limit = args.limit ?? 32
    const files = await window.api.fs.listFiles({
      rootPath: context.worktreePath,
      ...(context.connectionId ? { connectionId: context.connectionId } : {}),
      excludePaths: args.excludePaths,
      requestToken: args.requestToken,
      maxResults: limit + 1,
      ...(args.includeIgnored === undefined ? {} : { includeIgnored: args.includeIgnored }),
      ...(args.followSymlinks === undefined ? {} : { followSymlinks: args.followSymlinks }),
      ...(args.allowLegacyIncludeIgnored ? { allowLegacyIncludeIgnored: true } : {}),
      searchQuery: args.query
    })
    return { files: files.slice(0, limit), truncated: files.length > limit }
  }
  if (!context.worktreeId) {
    return { files: [], truncated: false }
  }
  const worktreeSelector = toRuntimeWorktreeSelector(context.worktreeId)
  const limit = args.limit ?? 32
  const searchLegacy = () =>
    searchLegacyQuickOpenInventory({
      target,
      worktreeSelector,
      query: args.query,
      limit,
      worktreePath: context.worktreePath,
      excludePaths: args.excludePaths,
      signal: args.signal
    })
  const searchLegacyOrRequireUpdate = async () => {
    try {
      return await searchLegacy()
    } catch (error) {
      if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
        throw new Error(QUICK_OPEN_REMOTE_UPDATE_REQUIRED_MESSAGE)
      }
      throw error
    }
  }
  if (
    args.includeIgnored !== false &&
    !args.followSymlinks &&
    hasCachedLegacyQuickOpenInventory(target, worktreeSelector, context.worktreePath)
  ) {
    return searchLegacy()
  }
  let result: RuntimeFileListResult
  try {
    result = await callRuntimeRpc<RuntimeFileListResult>(
      target,
      'files.searchPaths',
      {
        worktree: worktreeSelector,
        query: args.query,
        limit,
        excludePaths: args.excludePaths,
        ...(args.includeIgnored === undefined ? {} : { includeIgnored: args.includeIgnored }),
        ...(args.followSymlinks === undefined ? {} : { followSymlinks: args.followSymlinks }),
        ...(args.allowLegacyIncludeIgnored ? { allowLegacyIncludeIgnored: true } : {}),
        mode: 'quick-open'
      },
      { timeoutMs: 15_000, ...(args.signal === undefined ? {} : { signal: args.signal }) }
    )
  } catch (error) {
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      if (
        (args.includeIgnored === false && !args.allowLegacyIncludeIgnored) ||
        args.followSymlinks
      ) {
        throw new Error('Update the remote host to use Quick Open listing options.')
      }
      return searchLegacyOrRequireUpdate()
    }
    throw error
  }
  if (
    ((args.includeIgnored === false && !args.allowLegacyIncludeIgnored) || args.followSymlinks) &&
    (result.quickOpenSearchVersion ?? 0) < 2
  ) {
    throw new Error('Update the remote host to use Quick Open listing options.')
  }
  if (args.excludePaths?.length && (result.quickOpenSearchVersion ?? 0) < 1) {
    return searchLegacyOrRequireUpdate()
  }
  const excludePrefixes = buildExcludePathPrefixes(
    context.worktreePath ?? result.rootPath,
    args.excludePaths
  )
  return {
    files: result.files
      .map((entry) => entry.relativePath)
      .filter((relativePath) => !shouldExcludeQuickOpenRelPath(relativePath, excludePrefixes)),
    truncated: result.truncated
  }
}

/**
 * Best-effort abort of an in-flight listRuntimeFiles call (#7721). Switching
 * workspaces must stop the previous workspace's full-tree scan — over SSH an
 * abandoned scan keeps loading the relay and starves fs.readDir/fs.stat.
 */
export function cancelRuntimeFileList(
  context: RuntimeFileOperationArgs,
  requestToken: string
): void {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind !== 'environment' || !context.worktreeId) {
    void window.api.fs.cancelListFiles({ requestToken }).catch(() => {
      /* cancellation is advisory; the request path has its own timeouts */
    })
  }
  // Environment runtimes bound files.listAll with their own RPC timeout.
}
