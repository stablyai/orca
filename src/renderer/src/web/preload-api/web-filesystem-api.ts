import type { PreloadApi } from '../../../../preload/api-types'
import type { SearchResult } from '../../../../shared/code-search-types'
import { assertFileMutationOwnershipCapability } from '../../../../shared/file-mutation-ownership'
import type { DirEntry } from '../../../../shared/filesystem-entry-types'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import type { SshConnectionState } from '../../../../shared/ssh-types'
import { toRuntimeWorktreeSelector } from '../../runtime/runtime-worktree-selector'
import { createWebFileMutationMethods } from '../web-file-mutation-methods'
import { callRuntimeResult } from './web-runtime-calls'
import type { WebRuntimeEnvelopeCaller, WebRuntimeResultCaller } from './web-runtime-calls'
import {
  getClientForEnvironment,
  requireActiveEnvironment,
  requireActiveEnvironmentOrNull,
  runtimeCallQueuePool,
  updateEnvironmentFromResponse,
  webRuntimeState
} from './web-runtime-session'
import { isMissingPathError, resolveRuntimeFilePath } from './web-runtime-worktree-catalog'
import { noopUnsubscribe } from './web-storage'

export function createFileApi(): NonNullable<Partial<PreloadApi>['fs']> {
  return {
    readDir: async ({ dirPath }) => {
      const file = await resolveRuntimeFilePath(dirPath)
      return callRuntimeResult<DirEntry[]>('files.readDir', {
        worktree: toRuntimeWorktreeSelector(file.worktree.id),
        relativePath: file.relativePath
      })
    },
    readFile: async ({ filePath }) => {
      const file = await resolveRuntimeFilePath(filePath)
      return callRuntimeResult('files.readPreview', {
        worktree: toRuntimeWorktreeSelector(file.worktree.id),
        relativePath: file.relativePath
      })
    },
    readLocalLogTail: async () => {
      throw new Error('Local log tailing is unavailable in paired web clients.')
    },
    startLocalLogTail: async () => {
      throw new Error('Local log tailing is unavailable in paired web clients.')
    },
    stopLocalLogTail: async () => {},
    onLocalLogTailChanged: () => noopUnsubscribe,
    downloadFile: async () => {
      throw new Error('Remote file download is unavailable in paired web clients.')
    },
    downloadFolder: async () => {
      throw new Error('Remote folder download is unavailable in paired web clients.')
    },
    saveDownloadedFile: async () => {
      throw new Error('Remote file download is unavailable in paired web clients.')
    },
    startDownloadedFile: async () => {
      throw new Error('Remote file download is unavailable in paired web clients.')
    },
    appendDownloadedFileChunk: async () => {
      throw new Error('Remote file download is unavailable in paired web clients.')
    },
    finishDownloadedFile: async () => {
      throw new Error('Remote file download is unavailable in paired web clients.')
    },
    cancelDownloadedFile: async () => {
      throw new Error('Remote file download is unavailable in paired web clients.')
    },
    listMarkdownDocuments: async ({ rootPath }) => {
      const file = await resolveRuntimeFilePath(rootPath)
      return callRuntimeResult('files.listMarkdownDocuments', {
        worktree: toRuntimeWorktreeSelector(file.worktree.id)
      })
    },
    ...createWebFileMutationMethods({
      captureSession: captureWebFileMutationSession
    }),
    authorizeExternalPath: () => Promise.resolve(),
    stat: async ({ filePath }) => {
      const file = await resolveRuntimeFilePath(filePath)
      return callRuntimeResult('files.stat', {
        worktree: toRuntimeWorktreeSelector(file.worktree.id),
        relativePath: file.relativePath
      })
    },
    pathExists: async ({ filePath }) => {
      try {
        const file = await resolveRuntimeFilePath(filePath)
        await callRuntimeResult('files.stat', {
          worktree: toRuntimeWorktreeSelector(file.worktree.id),
          relativePath: file.relativePath
        })
        return true
      } catch (error) {
        if (isMissingPathError(error)) {
          return false
        }
        throw error
      }
    },
    listFiles: async ({ rootPath, excludePaths }) => {
      const file = await resolveRuntimeFilePath(rootPath)
      const result = await callRuntimeResult<{ files: { relativePath: string }[] }>(
        'files.listAll',
        {
          worktree: toRuntimeWorktreeSelector(file.worktree.id),
          excludePaths
        }
      )
      return result.files.map((entry) => entry.relativePath)
    },
    cancelListFiles: async () => {
      // Why: paired-web lists files over runtime RPC with its own timeout; there's no host-side scan to abort here.
    },
    search: async (args) => {
      const file = await resolveRuntimeFilePath(args.rootPath)
      return callRuntimeResult<SearchResult>('files.search', {
        worktree: toRuntimeWorktreeSelector(file.worktree.id),
        query: args.query,
        caseSensitive: args.caseSensitive,
        wholeWord: args.wholeWord,
        useRegex: args.useRegex,
        includePattern: args.includePattern,
        excludePattern: args.excludePattern,
        maxResults: args.maxResults
      })
    },
    importExternalPaths: async () => ({ results: [] }),
    stageExternalPathsForRuntimeUpload: async () => ({ sources: [] }),
    resolveDroppedPathsForAgent: async () => ({ resolvedPaths: [], skipped: [], failed: [] }),
    watchWorktree: () => Promise.resolve(),
    unwatchWorktree: () => Promise.resolve(),
    onFsChanged: () => noopUnsubscribe
  }
}

export function captureWebFileMutationSession(): {
  resolveFilePath: (filePath: string) => Promise<Awaited<ReturnType<typeof resolveRuntimeFilePath>>>
  assertMutationSupported: () => Promise<void>
  callRuntimeResult: WebRuntimeResultCaller
  getSshState: (targetId: string) => Promise<SshConnectionState | null>
} {
  const environment = requireActiveEnvironment()
  const client = getClientForEnvironment(environment)
  const assertCurrent = (): void => {
    if (
      webRuntimeState.activeClient !== client ||
      requireActiveEnvironmentOrNull()?.id !== environment.id
    ) {
      throw new Error('Runtime pairing changed; refresh and try again')
    }
  }
  const callBoundRuntimeEnvelope: WebRuntimeEnvelopeCaller = async <TResult>(
    method: string,
    params?: unknown,
    timeoutMs?: number
  ): Promise<RuntimeRpcResponse<TResult>> => {
    assertCurrent()
    const response = await runtimeCallQueuePool.enqueue(environment.id, method, () => {
      assertCurrent()
      return client.call(method, params, { timeoutMs })
    })
    assertCurrent()
    updateEnvironmentFromResponse(environment, response)
    return response as RuntimeRpcResponse<TResult>
  }
  const callBoundRuntimeResult: WebRuntimeResultCaller = async <TResult>(
    method: string,
    params?: unknown,
    timeoutMs?: number
  ): Promise<TResult> => {
    const response = await callBoundRuntimeEnvelope<TResult>(method, params, timeoutMs)
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    return response.result as TResult
  }
  return {
    resolveFilePath: (filePath) =>
      resolveRuntimeFilePath(
        filePath,
        undefined,
        callBoundRuntimeResult,
        callBoundRuntimeEnvelope,
        false,
        environment.id
      ),
    assertMutationSupported: async () => {
      assertFileMutationOwnershipCapability(
        await callBoundRuntimeResult<RuntimeStatus>('status.get', undefined, 15_000)
      )
    },
    callRuntimeResult: callBoundRuntimeResult,
    getSshState: async (targetId) =>
      (
        await callBoundRuntimeResult<{ state: SshConnectionState | null }>('ssh.getState', {
          targetId
        })
      ).state
  }
}
