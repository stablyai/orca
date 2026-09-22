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
  searchLegacyQuickOpenInventory
} from './runtime-legacy-quick-open-inventory'
import { callRuntimeRpc, getActiveRuntimeTarget, RuntimeRpcCallError } from './runtime-rpc-client'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'

const QUICK_OPEN_REMOTE_UPDATE_REQUIRED_MESSAGE =
  'Quick Open search requires a newer paired Orca host. Update the remote host and reconnect.'

export async function searchRuntimeFiles(
  context: RuntimeFileOperationArgs,
  options: SearchOptions
): Promise<SearchResult> {
  if (getRuntimeFileSearchRejectedField(options)) {
    return createEmptyRuntimeFileSearchResult()
  }
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind !== 'environment' || !context.worktreeId) {
    return window.api.fs.search({
      ...options,
      connectionId: context.connectionId
    })
  }
  const { rootPath: _rootPath, ...runtimeOptions } = options
  return callRuntimeRpc<SearchResult>(
    target,
    'files.search',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), ...runtimeOptions },
    { timeoutMs: 15_000 }
  )
}

export async function listRuntimeFiles(
  context: RuntimeFileOperationArgs,
  args: {
    rootPath: string
    excludePaths?: string[]
    requestToken?: string
    // Why: naming the cap is what makes a full page readable as "there is more". The host returns
    // the whole listing when no limit is named, so a caller that never states one cannot tell a
    // bound from a total.
    maxResults?: number
    signal?: AbortSignal
  }
): Promise<string[]> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind !== 'environment' || !context.worktreeId) {
    return window.api.fs.listFiles({
      rootPath: args.rootPath,
      connectionId: context.connectionId,
      excludePaths: args.excludePaths,
      requestToken: args.requestToken,
      ...(args.maxResults === undefined ? {} : { maxResults: args.maxResults })
    })
  }
  return callRuntimeRpc<string[]>(
    target,
    'files.listAll',
    {
      worktree: toRuntimeWorktreeSelector(context.worktreeId),
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
    excludePaths?: string[]
    requestToken?: string
    signal?: AbortSignal
  }
): Promise<{ files: string[]; truncated: boolean }> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind !== 'environment') {
    if (!context.connectionId || !context.worktreePath) {
      return { files: [], truncated: false }
    }
    const limit = args.limit ?? 32
    const files = await window.api.fs.listFiles({
      rootPath: context.worktreePath,
      connectionId: context.connectionId,
      excludePaths: args.excludePaths,
      requestToken: args.requestToken,
      maxResults: limit + 1,
      searchQuery: args.query
    })
    return { files: files.slice(0, limit), truncated: files.length > limit }
  }
  if (!context.worktreeId) {
    return { files: [], truncated: false }
  }
  const worktreeSelector = toRuntimeWorktreeSelector(context.worktreeId)
  const limit = args.limit ?? 32
  if (hasCachedLegacyQuickOpenInventory(target, worktreeSelector, context.worktreePath)) {
    return searchLegacyQuickOpenInventory({
      target,
      worktreeSelector,
      query: args.query,
      limit,
      worktreePath: context.worktreePath,
      excludePaths: args.excludePaths,
      signal: args.signal
    })
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
        mode: 'quick-open'
      },
      { timeoutMs: 15_000, ...(args.signal === undefined ? {} : { signal: args.signal }) }
    )
  } catch (error) {
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      try {
        return await searchLegacyQuickOpenInventory({
          target,
          worktreeSelector,
          query: args.query,
          limit,
          worktreePath: context.worktreePath,
          excludePaths: args.excludePaths,
          signal: args.signal
        })
      } catch (legacyError) {
        if (legacyError instanceof RuntimeRpcCallError && legacyError.code === 'method_not_found') {
          throw new Error(QUICK_OPEN_REMOTE_UPDATE_REQUIRED_MESSAGE)
        }
        throw legacyError
      }
    }
    throw error
  }
  if (
    args.excludePaths?.length &&
    !(typeof result.quickOpenSearchVersion === 'number' && result.quickOpenSearchVersion >= 1)
  ) {
    try {
      return await searchLegacyQuickOpenInventory({
        target,
        worktreeSelector,
        query: args.query,
        limit,
        worktreePath: context.worktreePath,
        excludePaths: args.excludePaths,
        signal: args.signal
      })
    } catch (legacyError) {
      if (legacyError instanceof RuntimeRpcCallError && legacyError.code === 'method_not_found') {
        throw new Error(QUICK_OPEN_REMOTE_UPDATE_REQUIRED_MESSAGE)
      }
      throw legacyError
    }
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
