import type { BrowserLoadError } from '../../../../../shared/browser-workspace-types'
import { convertBrowserPageToWorkspaceDoc } from '@/lib/file-preview'
import { resolveWorkspaceDocAddressTarget } from '@/lib/workspace-doc-address-input'
import { useAppStore } from '@/store'

/** Consume workspace paths before URL resolution targets the wrong host or a refused file: URL; return false to continue URL handling. */
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
