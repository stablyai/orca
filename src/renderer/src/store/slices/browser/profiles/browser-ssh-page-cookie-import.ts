import type { BrowserCookieImportResult } from '../../../../../../shared/browser/workspaces/browser-workspace-types'
import { errorMessage } from '../../../../../../shared/errors/error-message'
import { toSshExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type {
  BrowserCookieImportExecutionResult,
  BrowserSliceGet,
  BrowserSshPageCookieImportRoute
} from '../browser-slice-contract'

/** Settings' import state stays untouched: it describes the profile's jar, which this leaves alone. */
export async function importSshPageCookies(
  get: BrowserSliceGet,
  route: BrowserSshPageCookieImportRoute,
  request: () => Promise<BrowserCookieImportResult>
): Promise<BrowserCookieImportExecutionResult> {
  let result: BrowserCookieImportResult
  try {
    result = await request()
  } catch (err) {
    result = { ok: false, reason: errorMessage(err) }
  }
  if (result.ok) {
    get().recordFeatureInteraction?.('cookie-import')
  }
  return {
    ...result,
    executionHostId: toSshExecutionHostId(route.sshTargetId),
    executionHostLabel: route.hostLabel,
    executionMachine: 'client',
    executionRemoteEnvironment: true
  }
}
