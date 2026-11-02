import { getWorkspaceClientCreationActionPolicy } from '@/lib/client-creation-action-policy'
import { absolutePathToFileUri } from '@/components/editor/markdown-internal-links'
import { useAppStore } from '@/store'
import {
  openPlannedFileBrowserLink,
  type FileBrowserLinkTarget
} from '@/lib/file-preview-link-open'
import type { BrowserLinkOpenContext, BrowserOpenOutcome } from '@/lib/browser-link-destination'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { getWorkspaceFilePreviewPlan, openFileInBrowserTab } from '@/lib/file-preview'

export async function openResolvedHtmlFileInBrowser(
  params: FileBrowserLinkTarget & {
    clientLocal: boolean
    linkContext?: BrowserLinkOpenContext
  }
): Promise<BrowserOpenOutcome | null> {
  const state = useAppStore.getState()
  const url = absolutePathToFileUri(params.filePath)
  const title = params.filePath.split(/[/\\]/).pop() ?? params.filePath
  if (params.linkContext) {
    const context = params.clientLocal
      ? { ...params.linkContext, linkIntent: null }
      : params.linkContext
    // A client-local discovery from a remote source changes file scope, even in the same wrapper workspace.
    if (params.clientLocal && params.linkContext.linkIntent?.targetGroupId) {
      return { status: 'refused' }
    }
    return openPlannedFileBrowserLink(
      state,
      params,
      { status: 'browser-tab', url, title },
      context,
      (current) =>
        getWorkspaceClientCreationActionPolicy(current, params.worktreeId)['managed-browser']
          .state === 'enabled'
    )
  }
  if (params.worktreeId) {
    activateAndRevealWorkspace(params.worktreeId, { providesInitialSurface: true })
  }
  state.createBrowserTab(params.worktreeId, url, {
    title,
    activate: true,
    ...(params.clientLocal ? { browserRuntimeEnvironmentId: null } : {})
  })
  return null
}

type TerminalHtmlFileBrowserTarget = FileBrowserLinkTarget & {
  clientLocal: boolean
  canOpenWithSystemDefault: boolean
  linkContext?: BrowserLinkOpenContext
  refuseOpenInSourceGroup?: () => boolean
}

/** Returns true when the HTML link was opened or deliberately refused. */
export function openTerminalHtmlFileInBrowser(params: TerminalHtmlFileBrowserTarget): boolean {
  if (params.canOpenWithSystemDefault) {
    void openResolvedHtmlFileInBrowser(params).then((outcome) => {
      if (outcome?.status === 'refused' || outcome?.status === 'unsupported') {
        params.refuseOpenInSourceGroup?.()
      }
    })
    return true
  }

  const plan = getWorkspaceFilePreviewPlan(
    useAppStore.getState(),
    params.worktreeId,
    params.filePath
  )
  if (plan.status !== 'doc-preview') {
    return false
  }
  if (!params.linkContext) {
    activateAndRevealWorkspace(params.worktreeId, { providesInitialSurface: true })
  }
  openFileInBrowserTab({
    filePath: params.filePath,
    worktreeId: params.worktreeId,
    ...(params.linkContext ? { fileExecutionHostId: params.fileExecutionHostId } : {}),
    ...(params.linkContext
      ? {
          linkContext: params.linkContext,
          onLinkOutcome: (outcome) => {
            if (outcome.status === 'refused' || outcome.status === 'unsupported') {
              params.refuseOpenInSourceGroup?.()
            }
          }
        }
      : {})
  })
  return true
}

export function isHtmlFilePath(filePath: string): boolean {
  return /\.html?$/i.test(filePath)
}
