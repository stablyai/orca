import { callAbortableRuntimeEnvironment } from '../../runtime/abortable-runtime-environment-call'
import { unwrapRuntimeRpcResult } from '../../runtime/runtime-rpc-result'
import type { PreloadApi } from '../../../../preload/api-types'
import type { SearchResult } from '../../../../shared/code-search-types'
import { assertFileMutationOwnershipCapability } from '../../../../shared/file-mutation-ownership'
import type { DirEntry } from '../../../../shared/filesystem-entry-types'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import type { SshConnectionState } from '../../../../shared/ssh-types'
import { toRuntimeWorktreeSelector } from '../../runtime/runtime-worktree-selector'
import { createWebFileMutationMethods } from '../web-file-mutation-methods'
import { RUNTIME_CONNECTION_CHANGED_MESSAGE } from '../web-runtime-request-registry'
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
import { uploadBrowserFilesToWebAgentSessionAttachments } from './web-agent-session-attachment-upload'

export function createFileApi(): NonNullable<Partial<PreloadApi>['fs']> {
  const searches = new Map<string, AbortController>()
  return {
    prepareDroppedPaths: async () => {
      throw new Error('Preparing dropped file paths is not supported in the web client')
    },
    readFileChunk: async ({ filePath, offset, length }) => {
      const file = await resolveRuntimeFilePath(filePath)
      return callRuntimeResult('files.readChunk', {
        worktree: toRuntimeWorktreeSelector(file.worktree.id),
        relativePath: file.relativePath,
        offset,
        length
      })
    },
    readDir: async ({ dirPath }) => {
      const file = await resolveRuntimeFilePath(dirPath)
      return callRuntimeResult<DirEntry[]>('files.readDir', {
        worktree: toRuntimeWorktreeSelector(file.worktree.id),
        relativePath: file.relativePath
      })
    },
    // No orca-media protocol in a browser; audio and video keep the binary placeholder.
    grantRuntimeFilePreview: async () => null,
    // Never minted here, so no viewer asks.
    readPreviewRange: async () => {
      throw new Error('Preview ranges are not available in the web client')
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
      // Runtime RPC owns its timeout; no host-side search cancellation exists here.
    },
    cancelSearch: async ({ requestToken }) => {
      searches.get(requestToken)?.abort()
    },
    search: async (args) => {
      const controller = new AbortController()
      if (args.requestToken) {
        searches.get(args.requestToken)?.abort()
        searches.set(args.requestToken, controller)
      }
      try {
        const file = await resolveRuntimeFilePath(args.rootPath)
        const response = await callAbortableRuntimeEnvironment(
          requireActiveEnvironment().id,
          'files.search',
          {
            worktree: toRuntimeWorktreeSelector(file.worktree.id),
            query: args.query,
            caseSensitive: args.caseSensitive,
            wholeWord: args.wholeWord,
            useRegex: args.useRegex,
            includePattern: args.includePattern,
            excludePattern: args.excludePattern,
            maxResults: args.maxResults
          },
          15_000,
          controller.signal
        )
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: files.search publishes the same SearchResult contract as the native bridge.
        return unwrapRuntimeRpcResult(response as RuntimeRpcResponse<SearchResult>)
      } finally {
        if (args.requestToken && searches.get(args.requestToken) === controller) {
          searches.delete(args.requestToken)
        }
      }
    },
    importExternalPaths: async () => ({ results: [] }),
    stageExternalPathsForRuntimeUpload: async () => ({ sources: [] }),
    // Why: the web client has no local filesystem to stream from, so staging
    // never yields a source for this to upload.
    uploadExternalFileToRuntime: async () => {
      throw new Error('Uploading local files is not supported in the web client')
    },
    resolveDroppedPathsForAgent: async () => ({ resolvedPaths: [], skipped: [], failed: [] }),
    uploadPathsToAgentSessionAttachments: uploadBrowserFilesToWebAgentSessionAttachments,
    watchWorktree: () => Promise.resolve(),
    unwatchWorktree: () => Promise.resolve(),
    onFsChanged: () => noopUnsubscribe
  }
}

export function captureWebFileMutationSession(): {
  resolveFilePath: (filePath: string) => Promise<Awaited<ReturnType<typeof resolveRuntimeFilePath>>>
  assertMutationSupported: (options: { pinConnection: boolean }) => Promise<readonly string[]>
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
  let probedEpoch: number | undefined
  const callBoundRuntimeEnvelope: WebRuntimeEnvelopeCaller = async <TResult>(
    method: string,
    params?: unknown,
    timeoutMs?: number
  ): Promise<RuntimeRpcResponse<TResult>> => {
    assertCurrent()
    const response = await runtimeCallQueuePool.enqueue(environment.id, method, () => {
      assertCurrent()
      return client.call(method, params, { timeoutMs, expectedConnectionEpoch: probedEpoch })
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
    assertMutationSupported: async ({ pinConnection }) => {
      const epochBeforeProbe = client.connectionEpoch
      const status = await callBoundRuntimeResult<RuntimeStatus>('status.get', undefined, 15_000)
      assertFileMutationOwnershipCapability(status)
      if (!pinConnection) {
        return status.capabilities ?? []
      }
      // Why: the same client reconnects internally; a guarded write must reach the runtime that answered.
      if (client.connectionEpoch !== epochBeforeProbe) {
        throw new Error(RUNTIME_CONNECTION_CHANGED_MESSAGE)
      }
      probedEpoch = epochBeforeProbe
      return status.capabilities ?? []
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
