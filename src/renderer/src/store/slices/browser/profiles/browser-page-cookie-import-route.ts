import type { AppState } from '../../../types'
import type { BrowserClientHostCookieImportArgs } from '../../../../../../shared/browser/workspaces/browser-workspace-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import type { BrowserPageCookieImportRoute } from '../browser-slice-contract'

/** The host a page's own import fills; null for a Settings import, which follows the Settings host. */
export function pageCookieImportHostId(
  pageRoute: BrowserPageCookieImportRoute | null | undefined
): ExecutionHostId | null {
  if (!pageRoute) {
    return null
  }
  if (pageRoute.kind === 'client-host') {
    return toRuntimeExecutionHostId(pageRoute.environmentId)
  }
  return pageRoute.kind === 'ssh'
    ? toSshExecutionHostId(pageRoute.sshTargetId)
    : LOCAL_EXECUTION_HOST_ID
}

/** Main finds a page's jar from the page; a server profile's id names no profile here, so its metadata rides along. */
export function clientHostCookieImportTarget(
  state: Pick<AppState, 'browserSessionProfilesByHostId'>,
  environmentId: string,
  profileId: string,
  pageRoute: BrowserPageCookieImportRoute | null | undefined
): BrowserClientHostCookieImportArgs {
  if (pageRoute?.kind === 'client-host') {
    return { environmentId, profileId, browserPageId: pageRoute.browserPageId }
  }
  const profile = state.browserSessionProfilesByHostId[
    toRuntimeExecutionHostId(environmentId)
  ]?.find((entry) => entry.id === profileId)
  return {
    environmentId,
    profileId,
    ...(profile ? { profile: { id: profile.id, label: profile.label, scope: profile.scope } } : {})
  }
}
