import type {
  BrowserLinkOpenContext,
  BrowserOpenOutcome
} from '../navigation/browser-link-destination'
import { WorkspaceBrowserOpenError } from './workspace-browser-tab-presentation'
import {
  openWorkspaceBrowserTab,
  type OpenWorkspaceBrowserTabRequest
} from './workspace-browser-tab-open'

/** Detailed link results are additive to the generic page-id contract. */
export async function openWorkspaceBrowserTabForLink(
  request: OpenWorkspaceBrowserTabRequest & { linkContext: BrowserLinkOpenContext }
): Promise<BrowserOpenOutcome> {
  let outcome: BrowserOpenOutcome = { status: 'failed' }
  let reported = false
  try {
    await openWorkspaceBrowserTab({
      ...request,
      onLinkOutcome: (result) => {
        reported = true
        outcome = result
      }
    })
  } catch (error) {
    // A guard refusal already reported its outcome; the thrown cleanup must not turn it into failed.
    if (reported) {
      return outcome
    }
    if (request.linkContext.isCurrentRequest?.() === false) {
      return { status: 'superseded' }
    }
    // A failure that knows its reason keeps it, so the toast can name it.
    if (error instanceof WorkspaceBrowserOpenError) {
      throw error
    }
    return { status: 'failed' }
  }
  return outcome
}
