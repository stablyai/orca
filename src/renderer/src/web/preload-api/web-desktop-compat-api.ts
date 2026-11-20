import type { PreloadApi } from '../../../../preload/api-types'
import type { WslHostsPreloadApi } from '../../../../preload/api/wsl/wsl-hosts-api'
import type {
  DocPreviewCacheFileRequest,
  DocPreviewGrantRequest,
  DocPreviewResourceRequest
} from '../../../../preload/api/document-preview/doc-preview-api'
import type { DocPreviewFailure } from '../../../../shared/document-preview/doc-preview-scheme'
import type {
  WorkspaceSpaceAnalysis,
  WorkspaceSpaceAnalyzeInput,
  WorkspaceSpaceScanProgress
} from '../../../../shared/workspace-disk-space/workspace-space-types'
import { normalizeExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type {
  WslHostAddResult,
  WslHostCapability,
  WslHostDistro,
  WslHostServerStop,
  WslHostStatus
} from '../../../../shared/remote-runtime/wsl-hosts/wsl-host-types'
import { noopUnsubscribe } from './web-storage'
import { invokeNative, isTauriNativeHost, listenNative } from '../tauri-native-host'
import { callRuntimeResult } from '../runtime/client/web-runtime-calls'
import { onWslHostStatusChanged } from './web-wsl-runtime-events'

/** Desktop compatibility APIs, with Tauri-native implementations where available. */
export function createWebDocPreviewApi(): NonNullable<PreloadApi['docPreview']> {
  if (isTauriNativeHost()) {
    return {
      mintGrant: (request: DocPreviewGrantRequest) =>
        invokeNative<{ grantId: string; url: string }>('poc_doc_preview_mint_grant', {
          request
        }),
      revokeGrant: (grantId: string) =>
        invokeNative<boolean>('poc_doc_preview_revoke_grant', { grantId }),
      authorizeDirectory: (grantId: string, relativePath: string) =>
        invokeNative<boolean>('poc_doc_preview_authorize_directory', {
          grantId,
          relativePath
        }),
      cacheFile: (request: DocPreviewCacheFileRequest) =>
        invokeNative<boolean>('poc_doc_preview_cache_file', { request }),
      onExternalLink: (callback) =>
        listenNative<{ browserPageId: string; url: string }>(
          'doc-preview:external-link',
          ({ url }) => callback({ url })
        ),
      onLoadFailure: (callback) =>
        listenNative<DocPreviewFailure>('doc-preview:load-failure', callback),
      onResourceRequested: (callback: (payload: DocPreviewResourceRequest) => void) =>
        listenNative<DocPreviewResourceRequest>('doc-preview:resource-requested', callback)
    }
  }
  return {
    mintGrant: async () => {
      throw new Error('Document previews are unavailable in the Tauri client.')
    },
    revokeGrant: () => Promise.resolve(false),
    authorizeDirectory: () => Promise.resolve(false),
    cacheFile: () => Promise.resolve(false),
    onExternalLink: () => noopUnsubscribe,
    onLoadFailure: (_callback: (payload: DocPreviewFailure) => void) => noopUnsubscribe,
    onResourceRequested: (_callback: (payload: DocPreviewResourceRequest) => void) =>
      noopUnsubscribe
  }
}

type WorkspaceSpaceRevealPayload = {
  worktreeId: string
  executionHostId?: string
}

/** Space uses a second Tauri WebviewWindow and app events for renderer-to-renderer messages. */
export function createWebWorkspaceSpaceApi(): NonNullable<PreloadApi['workspaceSpace']> {
  if (isTauriNativeHost()) {
    return {
      analyze: (input?: WorkspaceSpaceAnalyzeInput) =>
        invokeNative<
          { ok: true; analysis: WorkspaceSpaceAnalysis } | { ok: false; cancelled: true }
        >('poc_workspace_space_analyze', { input: input ?? { repos: [], worktrees: [] } }),
      getCachedAnalysis: () =>
        invokeNative<WorkspaceSpaceAnalysis | null>('poc_workspace_space_get_cached_analysis'),
      cancel: () => invokeNative<boolean>('poc_workspace_space_cancel'),
      onProgress: (callback: (progress: WorkspaceSpaceScanProgress) => void) =>
        listenNative<WorkspaceSpaceScanProgress>('workspace-space:progress', callback),
      openWindow: () => invokeNative('poc_workspace_space_open'),
      closeWindow: () => invokeNative('poc_workspace_space_close'),
      publishWindowState: (state: unknown) =>
        invokeNative('poc_workspace_space_publish_window_state', { state }),
      requestWindowState: () => invokeNative('poc_workspace_space_request_window_state'),
      onWindowStateRequested: (callback) =>
        listenNative<void>('workspace-space:window-state-requested', callback),
      onWindowClosed: (callback) => listenNative<void>('workspace-space:window-closed', callback),
      onWindowState: (callback) => listenNative<unknown>('workspace-space:window-state', callback),
      revealWorktree: (worktreeId, executionHostId) =>
        invokeNative('poc_workspace_space_reveal_worktree', {
          worktreeId,
          executionHostId
        }),
      onRevealWorktree: (callback) =>
        listenNative<WorkspaceSpaceRevealPayload>('workspace-space:reveal-worktree', (payload) =>
          callback(
            payload.worktreeId,
            normalizeExecutionHostId(payload.executionHostId) ?? undefined
          )
        ),
      requestWorktreeRefresh: () => invokeNative('poc_workspace_space_request_worktree_refresh'),
      onWorktreeRefreshRequested: (callback) =>
        listenNative<void>('workspace-space:worktree-refresh-requested', callback),
      publishWindowAnalysis: (analysis) =>
        invokeNative('poc_workspace_space_publish_window_analysis', { analysis }),
      onWindowAnalysis: (callback) =>
        listenNative<WorkspaceSpaceAnalysis>('workspace-space:window-analysis', callback)
    }
  }

  return {
    analyze: () => Promise.resolve({ ok: false, cancelled: true }),
    getCachedAnalysis: () => Promise.resolve(null),
    cancel: () => Promise.resolve(false),
    onProgress: () => noopUnsubscribe,
    openWindow: () => Promise.resolve(),
    closeWindow: () => Promise.resolve(),
    publishWindowState: () => Promise.resolve(),
    requestWindowState: () => Promise.resolve(),
    onWindowStateRequested: () => noopUnsubscribe,
    onWindowClosed: () => noopUnsubscribe,
    onWindowState: () => noopUnsubscribe,
    revealWorktree: () => Promise.resolve(),
    onRevealWorktree: () => noopUnsubscribe,
    requestWorktreeRefresh: () => Promise.resolve(),
    onWorktreeRefreshRequested: () => noopUnsubscribe,
    publishWindowAnalysis: () => Promise.resolve(),
    onWindowAnalysis: () => noopUnsubscribe
  }
}

/** Automation records and dispatch state are owned by the paired runtime in Tauri. */
export function createWebAutomationsApi(): NonNullable<PreloadApi['automations']> {
  return {
    listExternalManagerForOwner: () =>
      Promise.resolve({ manager: null, error: null, updatedAt: Date.now() }),
    runExternalActionForOwner: () => Promise.resolve(),
    retainExternalScopes: () => Promise.resolve(),
    snapshotWorkspaceName: () => Promise.resolve(0),
    onChanged: () => noopUnsubscribe
  }
}

/** WSL host management is routed through the local orcad runtime in Tauri. */
export function createWebWslHostsApi(): WslHostsPreloadApi {
  return {
    getCapability: () =>
      callRuntimeResult<WslHostCapability>('wslHosts.getCapability').catch(() => ({
        serverFiles: false
      })),
    listDistros: () => callRuntimeResult<WslHostDistro[]>('wslHosts.listDistros').catch(() => []),
    add: (args) => callRuntimeResult<WslHostAddResult>('wslHosts.add', args),
    remove: (args) => callRuntimeResult<WslHostServerStop>('wslHosts.remove', args),
    connect: (args) => callRuntimeResult<void>('wslHosts.connect', args),
    getStatuses: () => callRuntimeResult<WslHostStatus[]>('wslHosts.getStatuses').catch(() => []),
    onStatusChanged: onWslHostStatusChanged,
    onCapabilityChanged: () => noopUnsubscribe,
    setVisibleWork: (args) =>
      callRuntimeResult<void>('wslHosts.setVisibleWork', args).catch(() => {}),
    // The paired host owns its own window focus; a browser client cannot raise it.
    focusHost: () => Promise.resolve()
  }
}
