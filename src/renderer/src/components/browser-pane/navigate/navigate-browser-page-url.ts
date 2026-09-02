import { detectLanguage } from '@/lib/language-detect'
import { getConnectionId } from '@/lib/connection-context'
import { isPathInsideWorktree, toWorktreeRelativePath } from '@/lib/terminal-links'
import { useAppStore } from '@/store'
import {
  isRemoteRuntimeFileOperation,
  statRuntimePath,
  type RuntimeFileOperationArgs
} from '@/runtime/runtime-file-client'
import {
  normalizeBrowserNavigationUrl,
  redactKagiSessionToken
} from '../../../../../shared/browser-url'
import type { BrowserLoadError } from '../../../../../shared/browser-workspace-types'
import { ORCA_BROWSER_BLANK_URL } from '../../../../../shared/constants'
import { BROWSER_GUEST_RECOVERY_ERROR_CODE } from '../host-guest/browser-page-guest-recovery'
import {
  getBrowserDisplayTitle,
  getNotebookPathFromBrowserUrl,
  toDisplayUrl
} from '../describe-page/browser-page-url-display'
import type {
  BrowserPageRecoveryNavigationValidation,
  BrowserPageUrlSetter,
  BrowserTabPageState
} from '../describe-page/browser-page-types'
import type { MutableRefObject } from 'react'

export type NavigateBrowserPageToUrlArgs = {
  url: string
  browserTabId: string
  worktreeId: string
  activeLoadFailureRef: MutableRefObject<BrowserLoadError | null>
  lastKnownWebviewUrlRef: MutableRefObject<string | null>
  trackNextLoadingEventRef: MutableRefObject<boolean>
  recoveryNavigationValidationRef: MutableRefObject<BrowserPageRecoveryNavigationValidation | null>
  webviewRef: MutableRefObject<Electron.WebviewTag | null>
  onSetUrlRef: MutableRefObject<BrowserPageUrlSetter>
  onUpdatePageStateRef: MutableRefObject<(tabId: string, updates: BrowserTabPageState) => void>
  setAddressBarValue: (value: string) => void
  setResourceNotice: (notice: string | null) => void
  focusWebviewNow: () => boolean
}

export function navigateBrowserPageToUrl({
  url,
  browserTabId,
  worktreeId,
  activeLoadFailureRef,
  lastKnownWebviewUrlRef,
  trackNextLoadingEventRef,
  recoveryNavigationValidationRef,
  webviewRef,
  onSetUrlRef,
  onUpdatePageStateRef,
  setAddressBarValue,
  setResourceNotice,
  focusWebviewNow
}: NavigateBrowserPageToUrlArgs): void {
  const navigateBrowserUrl = (targetUrl: string): void => {
    const browserModelUrl = redactKagiSessionToken(targetUrl)
    const normalizedBrowserModelUrl =
      normalizeBrowserNavigationUrl(browserModelUrl) ?? browserModelUrl
    const recoveryLoadError =
      activeLoadFailureRef.current?.code === BROWSER_GUEST_RECOVERY_ERROR_CODE
        ? activeLoadFailureRef.current
        : null
    setAddressBarValue(toDisplayUrl(browserModelUrl))
    onSetUrlRef.current(browserTabId, browserModelUrl)
    onUpdatePageStateRef.current(browserTabId, {
      loading: true,
      loadError: recoveryLoadError,
      title: getBrowserDisplayTitle(browserModelUrl, browserModelUrl)
    })
    setResourceNotice(null)

    const webview = webviewRef.current
    if (!webview) {
      return
    }
    trackNextLoadingEventRef.current = targetUrl !== ORCA_BROWSER_BLANK_URL
    lastKnownWebviewUrlRef.current = normalizedBrowserModelUrl
    recoveryNavigationValidationRef.current = recoveryLoadError
      ? { committed: false, started: false, targetUrl: normalizedBrowserModelUrl }
      : null
    webview.src = targetUrl
    if (targetUrl !== ORCA_BROWSER_BLANK_URL) {
      focusWebviewNow()
    }
  }

  const notebookPath = getNotebookPathFromBrowserUrl(url)
  if (notebookPath) {
    void (async () => {
      const store = useAppStore.getState()
      const connectionId = getConnectionId(worktreeId)
      if (connectionId !== null) {
        navigateBrowserUrl(url)
        return
      }

      try {
        const activeWorktree = store.allWorktrees().find((w) => w.id === worktreeId)
        const fileContext: RuntimeFileOperationArgs = {
          settings: store.settings,
          worktreeId,
          worktreePath: activeWorktree?.path,
          connectionId: undefined
        }
        if (!isRemoteRuntimeFileOperation(fileContext, notebookPath)) {
          await window.api.fs.authorizeExternalPath({ targetPath: notebookPath })
        }
        const stat = await statRuntimePath(fileContext, notebookPath)
        if (stat.isDirectory) {
          navigateBrowserUrl(url)
          return
        }

        let relativePath = notebookPath
        if (activeWorktree?.path && isPathInsideWorktree(notebookPath, activeWorktree.path)) {
          relativePath = toWorktreeRelativePath(notebookPath, activeWorktree.path) ?? notebookPath
        }

        // Why: file:// notebooks in the browser are otherwise rendered as raw JSON by Chromium.
        store.setActiveTabType('editor')
        store.openFile(
          {
            filePath: notebookPath,
            relativePath,
            worktreeId,
            language: detectLanguage(notebookPath),
            mode: 'edit'
          },
          { preview: false, targetGroupId: store.ensureWorktreeRootGroup(worktreeId) }
        )
      } catch {
        navigateBrowserUrl(url)
      }
    })()
    return
  }

  navigateBrowserUrl(url)
}
