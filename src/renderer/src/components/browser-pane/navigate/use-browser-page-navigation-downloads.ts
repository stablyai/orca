import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type DragEvent,
  type MutableRefObject,
  type SetStateAction
} from 'react'
import { translate } from '@/i18n/i18n'
import { convertBrowserPageToWorkspaceDoc } from '@/lib/browser/documents/file-preview-page-conversion'
import { routeWorkspaceDocAddressSubmission } from './workspace-doc-address-submission'
import {
  acceptBrowserPageWorkspaceFileDragOver,
  resolveBrowserPageWorkspaceFileDrop
} from './browser-page-workspace-file-drop'
import type { BrowserLoadError } from '../../../../../shared/browser/workspaces/browser-workspace-types'
import { resolveBrowserAddressBarSubmission } from './browser-address-bar-navigation'
import { navigateBrowserPageToUrl } from './navigate-browser-page-url'
import type { BrowserDownloadState } from './browser-download-progress'
import { toDisplayUrl } from '../describe-page/browser-page-url-display'
import { useBrowserPageDownloadEvents } from './use-browser-page-download-events'
import type {
  BrowserPageRecoveryNavigationValidation,
  BrowserPageUrlSetter,
  BrowserTabPageState
} from '../describe-page/browser-page-types'

export function useBrowserPageNavigationDownloads({
  browserTabId,
  worktreeId,
  webviewRef,
  activeLoadFailureRef,
  lastKnownWebviewUrlRef,
  recoveryNavigationValidationRef,
  onSetUrlRef,
  onUpdatePageStateRef,
  keepAddressBarFocusRef,
  focusWebviewNow,
  setResourceNotice,
  addressBarValueRef,
  addressBarInputRef,
  browserTabUrl
}: {
  browserTabId: string
  worktreeId: string
  webviewRef: MutableRefObject<Electron.WebviewTag | null>
  activeLoadFailureRef: MutableRefObject<BrowserLoadError | null>
  lastKnownWebviewUrlRef: MutableRefObject<string | null>
  recoveryNavigationValidationRef: MutableRefObject<BrowserPageRecoveryNavigationValidation | null>
  onSetUrlRef: MutableRefObject<BrowserPageUrlSetter>
  onUpdatePageStateRef: MutableRefObject<(tabId: string, updates: BrowserTabPageState) => void>
  keepAddressBarFocusRef: MutableRefObject<boolean>
  focusWebviewNow: () => boolean
  setResourceNotice: (notice: string | null) => void
  addressBarValueRef: MutableRefObject<string>
  addressBarInputRef: MutableRefObject<HTMLInputElement | null>
  browserTabUrl: string
}): {
  addressBarValue: string
  setAddressBarValue: Dispatch<SetStateAction<string>>
  submitAddressBar: () => void
  navigateToUrl: (url: string) => void
  visibleDownloads: BrowserDownloadState[]
  dismissBrowserDownload: (downloadId: string) => void
  handleOpenDownloadedFile: (download: BrowserDownloadState) => Promise<void>
  handleShowDownloadedFile: (download: BrowserDownloadState) => Promise<void>
  handleInternalFileDragOverRef: MutableRefObject<(event: DragEvent<HTMLDivElement>) => void>
  handleInternalFileDropRef: MutableRefObject<(event: DragEvent<HTMLDivElement>) => void>
} {
  const [addressBarValue, setAddressBarValue] = useState(() => toDisplayUrl(browserTabUrl))
  const { downloadStates, setDownloadStates } = useBrowserPageDownloadEvents({
    browserTabId,
    setResourceNotice
  })
  const handleInternalFileDragOverRef = useRef<(event: DragEvent<HTMLDivElement>) => void>(() => {})
  const handleInternalFileDropRef = useRef<(event: DragEvent<HTMLDivElement>) => void>(() => {})

  useEffect(() => {
    // Why: don't clobber an in-progress address-bar query when an async URL update lands; syncing resumes once the input blurs.
    if (document.activeElement === addressBarInputRef.current) {
      return
    }
    setAddressBarValue(toDisplayUrl(browserTabUrl))
  }, [addressBarInputRef, browserTabUrl])

  useEffect(() => {
    addressBarValueRef.current = addressBarValue
  }, [addressBarValue, addressBarValueRef])

  const navigateToUrl = useCallback(
    (url: string): void => {
      navigateBrowserPageToUrl({
        url,
        browserTabId,
        worktreeId,
        activeLoadFailureRef,
        lastKnownWebviewUrlRef,
        recoveryNavigationValidationRef,
        webviewRef,
        onSetUrlRef,
        onUpdatePageStateRef,
        setAddressBarValue,
        setResourceNotice,
        focusWebviewNow
      })
    },
    [
      activeLoadFailureRef,
      browserTabId,
      focusWebviewNow,
      lastKnownWebviewUrlRef,
      onSetUrlRef,
      onUpdatePageStateRef,
      recoveryNavigationValidationRef,
      setResourceNotice,
      webviewRef,
      worktreeId
    ]
  )

  const submitAddressBar = (): void => {
    keepAddressBarFocusRef.current = false
    const consumedAsWorkspaceDoc = routeWorkspaceDocAddressSubmission({
      worktreeId,
      pageId: browserTabId,
      value: addressBarValue,
      onLoadError: (loadError) => onUpdatePageStateRef.current(browserTabId, { loadError })
    })
    if (consumedAsWorkspaceDoc) {
      return
    }
    const submission = resolveBrowserAddressBarSubmission(addressBarValue, {
      allowExtensionPages: true
    })
    if (submission.status === 'invalid') {
      onUpdatePageStateRef.current(browserTabId, { loadError: submission.loadError })
      return
    }
    navigateToUrl(submission.url)
  }

  const handleInternalFileDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    acceptBrowserPageWorkspaceFileDragOver(event)
  }, [])

  const handleInternalFileDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      const drop = resolveBrowserPageWorkspaceFileDrop(event, {
        worktreeId,
        // The container stays laid out when a load failure hides the guest.
        pageRect: webviewRef.current?.parentElement?.getBoundingClientRect() ?? null,
        allowFileUrl: true
      })
      if (drop?.kind === 'notice') {
        setResourceNotice(drop.message)
      } else if (drop?.kind === 'navigate') {
        navigateToUrl(drop.url)
      } else if (drop?.kind === 'workspace-doc') {
        convertBrowserPageToWorkspaceDoc(browserTabId, drop.docLocation)
      }
    },
    [browserTabId, navigateToUrl, setResourceNotice, webviewRef, worktreeId]
  )

  useLayoutEffect(() => {
    handleInternalFileDragOverRef.current = handleInternalFileDragOver
    handleInternalFileDropRef.current = handleInternalFileDrop
  }, [handleInternalFileDragOver, handleInternalFileDrop])

  const dismissBrowserDownload = useCallback(
    (downloadId: string) => {
      setDownloadStates((current) =>
        current.filter((download) => download.downloadId !== downloadId)
      )
    },
    [setDownloadStates]
  )

  const handleOpenDownloadedFile = useCallback(
    async (download: BrowserDownloadState) => {
      if (!download.savePath) {
        setResourceNotice(
          translate(
            'auto.components.browser.pane.BrowserPane.9f6f2e8c19',
            'The downloaded file path is unavailable.'
          )
        )
        return
      }
      const opened = await window.api.shell.openFilePath(download.savePath, LOCAL_EXECUTION_HOST_ID)
      if (!opened) {
        setResourceNotice(
          translate(
            'auto.components.browser.pane.BrowserPane.0c79b7634d',
            'Could not open the downloaded file. It may have been moved or deleted.'
          )
        )
      }
    },
    [setResourceNotice]
  )

  const handleShowDownloadedFile = useCallback(
    async (download: BrowserDownloadState) => {
      if (!download.savePath) {
        setResourceNotice(
          translate(
            'auto.components.browser.pane.BrowserPane.9f6f2e8c19',
            'The downloaded file path is unavailable.'
          )
        )
        return
      }
      const result = await window.api.shell.openInFileManager(
        download.savePath,
        LOCAL_EXECUTION_HOST_ID
      )
      if (!result.ok) {
        setResourceNotice(
          translate(
            'auto.components.browser.pane.BrowserPane.397d9dc923',
            'Could not show the downloaded file. It may have been moved or deleted.'
          )
        )
      }
    },
    [setResourceNotice]
  )

  const visibleDownloads = (() => {
    const active = downloadStates.filter((download) => download.status === 'downloading')
    const recent = downloadStates
      .filter((download) => download.status !== 'downloading')
      .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
      .slice(0, 3)
    return [...active, ...recent]
  })()

  return {
    addressBarValue,
    setAddressBarValue,
    submitAddressBar,
    navigateToUrl,
    visibleDownloads,
    dismissBrowserDownload,
    handleOpenDownloadedFile,
    handleShowDownloadedFile,
    handleInternalFileDragOverRef,
    handleInternalFileDropRef
  }
}
