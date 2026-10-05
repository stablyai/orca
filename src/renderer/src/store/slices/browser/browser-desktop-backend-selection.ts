import type { BrowserPageDesktopBackend } from '../../../../../shared/browser-workspace-types'
import { getConnectionIdFromState } from '@/lib/connection-owner-resolution'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import type { BrowserSliceGet, CreateBrowserPageOptions } from './browser-slice-contract'

export function selectNewDesktopBrowserBackend({
  requested,
  desktopAvailable,
  connectionId,
  runtimeEnvironmentId,
  workspaceDocument,
  routedPartition
}: {
  requested: BrowserPageDesktopBackend | undefined
  desktopAvailable: boolean
  connectionId: string | null | undefined
  runtimeEnvironmentId: string | null
  workspaceDocument: boolean
  routedPartition: boolean
}): BrowserPageDesktopBackend | undefined {
  if (requested === 'webview') {
    return requested
  }
  if (
    !desktopAvailable ||
    connectionId !== null ||
    runtimeEnvironmentId !== null ||
    workspaceDocument ||
    routedPartition
  ) {
    if (requested === 'owned-view') {
      throw new Error('The owned browser view requires a resolved local desktop URL page.')
    }
    return undefined
  }
  return 'owned-view'
}

export function resolveNewDesktopBrowserBackend(
  get: BrowserSliceGet,
  worktreeId: string,
  options: CreateBrowserPageOptions | undefined,
  sessionPartition?: string | null
): BrowserPageDesktopBackend | undefined {
  const state = get()
  return selectNewDesktopBrowserBackend({
    requested: options?.desktopBackend,
    desktopAvailable: typeof window !== 'undefined' && Boolean(window.api.browser.desktopView),
    connectionId: getConnectionIdFromState(state, worktreeId),
    runtimeEnvironmentId:
      options?.browserRuntimeEnvironmentId === undefined
        ? getRuntimeEnvironmentIdForWorktree(state, worktreeId)
        : options.browserRuntimeEnvironmentId,
    workspaceDocument: Boolean(options?.docLocation),
    routedPartition: Boolean(sessionPartition?.startsWith('persist:orca-browser-v1-'))
  })
}
