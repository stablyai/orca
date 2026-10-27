import type { AppState } from '../../types'
import type {
  BrowserCookieImportResult,
  BrowserPage,
  BrowserSessionProfile
} from '../../../../../shared/browser-workspace-types'
import {
  getSettingsFocusedExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host'
import type {
  BrowserSlice,
  BrowserCookieImportExecutionResult,
  RemoteBrowserPageHandle
} from './browser-slice-contract'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'

/** Seed restored handles only for client-hosted pages, without dead lease placement generations. Server-hosted pages may vanish during runtime restart; leaving their handle absent recreates the saved URL instead of adopting a missing page and deleting the row. First snapshot supplies live placement. */
export function buildRestoredRemoteBrowserPageHandles(
  browserPagesByWorkspace: Record<string, BrowserPage[]>
): Record<string, RemoteBrowserPageHandle> {
  const handles: Record<string, RemoteBrowserPageHandle> = {}
  for (const pages of Object.values(browserPagesByWorkspace)) {
    for (const page of pages) {
      if (
        !page.browserRuntimeEnvironmentId ||
        !page.remoteBrowserPageId ||
        !page.remoteBrowserPageClientHosted
      ) {
        continue
      }
      handles[page.id] = {
        environmentId: page.browserRuntimeEnvironmentId,
        remotePageId: page.remoteBrowserPageId,
        restoredFromSession: true,
        restoredClientHosted: true
      }
    }
  }
  return handles
}

/** Staged/restored client-hosted rows must mount local guests before placement confirmation, never streamed panes. */
export function isClientHostedBrowserPageHandle(handle: RemoteBrowserPageHandle): boolean {
  return (
    handle.placement?.kind === 'client' ||
    (handle.staged === true && handle.stagedClientHosted === true) ||
    handle.restoredClientHosted === true
  )
}

export function retainCookieImportExecutionHost(
  result: BrowserCookieImportResult,
  executionHostId: ExecutionHostId,
  executionHostLabel: string,
  executionMachine: 'client' | 'remote'
): BrowserCookieImportExecutionResult {
  return {
    ...result,
    executionHostId,
    executionHostLabel,
    executionMachine,
    executionRemoteEnvironment: parseExecutionHostId(executionHostId)?.kind === 'runtime'
  }
}

export function getBrowserSettingsHostId(
  state: Pick<AppState, 'browserSessionHostIdOverride' | 'settings'>
): ExecutionHostId {
  return state.browserSessionHostIdOverride ?? getSettingsFocusedExecutionHostId(state.settings)
}

export function getBrowserSettingsRuntimeEnvironmentId(
  state: Pick<AppState, 'browserSessionHostIdOverride' | 'settings'>
): string | null {
  const parsed = parseExecutionHostId(getBrowserSettingsHostId(state))
  return parsed?.kind === 'runtime' ? parsed.environmentId : null
}

export function getBrowserWorktreeHostId(state: AppState, worktreeId: string): ExecutionHostId {
  return getExecutionHostIdForWorktree(state, worktreeId)
}

export function getBrowserSessionProfileHostId(
  state: AppState,
  worktreeId: string,
  browserRuntimeEnvironmentId: string | null | undefined
): ExecutionHostId {
  if (browserRuntimeEnvironmentId === null) {
    return LOCAL_EXECUTION_HOST_ID
  }
  if (browserRuntimeEnvironmentId !== undefined) {
    const runtimeEnvironmentId = browserRuntimeEnvironmentId.trim()
    return runtimeEnvironmentId
      ? toRuntimeExecutionHostId(runtimeEnvironmentId)
      : LOCAL_EXECUTION_HOST_ID
  }
  return getBrowserWorktreeHostId(state, worktreeId)
}

export function isLocalBrowserPageOwner(
  state: AppState,
  worktreeId: string,
  browserRuntimeEnvironmentId: string | null | undefined
): boolean {
  return (
    parseExecutionHostId(
      getBrowserSessionProfileHostId(state, worktreeId, browserRuntimeEnvironmentId)
    )?.kind !== 'runtime'
  )
}

export function profileListByHostUpdate(
  state: Pick<
    AppState,
    'browserSessionHostIdOverride' | 'browserSessionProfilesByHostId' | 'settings'
  >,
  profiles: BrowserSessionProfile[],
  hostId: ExecutionHostId = getBrowserSettingsHostId(state)
): Partial<BrowserSlice> {
  return {
    ...(getBrowserSettingsHostId(state) === hostId ? { browserSessionProfiles: profiles } : {}),
    browserSessionProfilesByHostId: {
      ...state.browserSessionProfilesByHostId,
      [hostId]: profiles
    }
  }
}

/** A host's full listing; it also drops a default pick the host no longer lists, so new tabs don't open on a deleted profile. */
export function listedProfilesByHostUpdate(
  state: AppState,
  profiles: BrowserSessionProfile[],
  hostId: ExecutionHostId
): Partial<BrowserSlice> {
  const isUnlisted = (profileId: string | null | undefined): boolean =>
    !!profileId && !profiles.some((profile) => profile.id === profileId)
  const update = profileListByHostUpdate(state, profiles, hostId)
  return {
    ...update,
    // Why: the unkeyed default belongs to the Settings host, the one whose list the mirror follows.
    ...(update.browserSessionProfiles && isUnlisted(state.defaultBrowserSessionProfileId)
      ? { defaultBrowserSessionProfileId: null }
      : {}),
    ...(isUnlisted(state.defaultBrowserSessionProfileIdByHostId[hostId])
      ? {
          defaultBrowserSessionProfileIdByHostId: {
            ...state.defaultBrowserSessionProfileIdByHostId,
            [hostId]: null
          }
        }
      : {})
  }
}

export function getBrowserProfilesForHost(
  state: AppState,
  hostId: ExecutionHostId
): BrowserSessionProfile[] {
  return (
    state.browserSessionProfilesByHostId[hostId] ??
    (getBrowserSettingsHostId(state) === hostId ? state.browserSessionProfiles : [])
  )
}

export function getDefaultBrowserProfileForHost(
  state: AppState,
  hostId: ExecutionHostId
): string | null {
  return (
    state.defaultBrowserSessionProfileIdByHostId[hostId] ??
    (getBrowserSettingsHostId(state) === hostId ? state.defaultBrowserSessionProfileId : null)
  )
}

export function browserImportStateForHostUpdate(
  state: AppState,
  hostId: ExecutionHostId,
  browserSessionImportState: BrowserSlice['browserSessionImportState']
): Partial<BrowserSlice> {
  return getBrowserSettingsHostId(state) === hostId ? { browserSessionImportState } : state
}

export function getFallbackTabTypeForWorktree(
  worktreeId: string,
  openFiles: AppState['openFiles'],
  terminalTabsByWorktree: AppState['tabsByWorktree'],
  browserTabsByWorktree?: AppState['browserTabsByWorktree']
): AppState['activeTabType'] {
  if (openFiles.some((file) => file.worktreeId === worktreeId)) {
    return 'editor'
  }
  if ((browserTabsByWorktree?.[worktreeId] ?? []).length > 0) {
    return 'browser'
  }
  if ((terminalTabsByWorktree[worktreeId] ?? []).length > 0) {
    return 'terminal'
  }
  return 'terminal'
}
