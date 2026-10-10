import type { BrowserLoadError } from '../../../../../shared/browser-workspace-types'
import { convertBrowserPageToWorkspaceDoc } from '@/lib/file-preview'
import { resolveWorkspaceDocAddressTarget } from '@/lib/workspace-doc-address-input'
import { useAppStore } from '@/store'

/**
 * The workspace-document leg of an address-bar submission, shared by every URL pane: a typed
 * workspace path converts the page (or activates the tab already showing that document) instead of
 * navigating — checked before the URL pipeline turns paths into file://, which a client-hosted
 * guest refuses and which resolves on the wrong machine for a remote worktree.
 *
 * Returns true when the submission was consumed (converted, activated, or refused with an error);
 * false hands the input to the URL pipeline untouched.
 */
export function routeWorkspaceDocAddressSubmission(params: {
  worktreeId: string
  pageId: string
  value: string
  onLoadError: (loadError: BrowserLoadError) => void
}): boolean {
  const docTarget = resolveWorkspaceDocAddressTarget(
    useAppStore.getState(),
    params.worktreeId,
    params.value
  )
  if (docTarget.status === 'workspace-doc') {
    convertBrowserPageToWorkspaceDoc(params.pageId, docTarget.docLocation)
    return true
  }
  if (docTarget.status === 'unsupported') {
    params.onLoadError({
      code: 0,
      description: docTarget.message,
      validatedUrl: params.value.trim() || 'about:blank'
    })
    return true
  }
  return false
}
