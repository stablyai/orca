import type { BrowserPageInventoryEntry } from '../../../../shared/browser/runtime/browser-page-inventory'
import { getBrowserPageRuntimeEnvironmentId } from '../../../../shared/browser/browser-page-runtime-owner'
import { isDocPreviewUrl } from '../../../../shared/document-preview/doc-preview-scheme'
import type { MobileSessionWorktreeInputs } from './types'

export function buildBrowserPageInventory(
  inputs: Pick<
    MobileSessionWorktreeInputs,
    | 'browserWorkspaces'
    | 'browserRuntimeEnvironmentId'
    | 'pagesByBrowserWorkspaceId'
    | 'certificateFailureByBrowserPageId'
  >
): BrowserPageInventoryEntry[] {
  const inventory: BrowserPageInventoryEntry[] = []
  for (const workspace of inputs.browserWorkspaces) {
    const pages = inputs.pagesByBrowserWorkspaceId.get(workspace.id)
    // Legacy workspace-as-page records have no modern page membership to enumerate.
    if (
      !pages?.length &&
      workspace.pageIds === undefined &&
      workspace.activePageId &&
      inputs.browserRuntimeEnvironmentId === null &&
      !workspace.docLocation &&
      !isDocPreviewUrl(workspace.url)
    ) {
      inventory.push({
        browserPageId: workspace.activePageId,
        browserWorkspaceId: workspace.id,
        title: workspace.title,
        url: workspace.url,
        profileId:
          workspace.sessionProfileId === undefined
            ? null
            : (workspace.sessionProfileId ?? 'default'),
        loadError: workspace.loadError,
        certificateFailure: null
      })
    }
    for (const page of pages ?? []) {
      if (
        page.docLocation ||
        isDocPreviewUrl(page.url) ||
        getBrowserPageRuntimeEnvironmentId(page, inputs.browserRuntimeEnvironmentId)
      ) {
        continue
      }
      inventory.push({
        browserPageId: page.id,
        browserWorkspaceId: workspace.id,
        title: page.title,
        url: page.url,
        profileId:
          workspace.sessionProfileId === undefined
            ? null
            : (workspace.sessionProfileId ?? 'default'),
        loadError: page.loadError,
        certificateFailure: inputs.certificateFailureByBrowserPageId.get(page.id) ?? null
      })
    }
  }
  return inventory
}
