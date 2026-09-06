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
import { getWorkspaceFileBrowserOpenTarget } from '@/lib/file-preview'
import { routeWorkspaceDocAddressSubmission } from './workspace-doc-address-submission'
import {
  getWorkspaceFileDragRejectionMessage,
  readWorkspaceFileDragPaths,
  WORKSPACE_FILE_PATH_MIME
} from '@/lib/workspace-file-drag'
import type { BrowserLoadError } from '../../../../../shared/browser-workspace-types'
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
  trackNextLoadingEventRef,
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
  trackNextLoadingEventRef: MutableRefObject<boolean>
  recoveryNavigationValidationRef: MutableRefObject<BrowserPageRecoveryNavigationValidation | null>
  onSetUrlRef: MutableRefObject<BrowserPageUrlSetter>
  onUpdatePageStateRef: MutableRefObject<(tabId: string, updates: BrowserTabPageState) => void>
  keepAddressBarFocusRef: MutableRefObject<boolean>
  focusWebviewNow: () => boolean
  setResourceNotice: Dispatch<SetStateAction<string | null>>
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
        trackNextLoadingEventRef,
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
      trackNextLoadingEventRef,
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
    const submission = resolveBrowserAddressBarSubmission(addressBarValue)
    if (submission.status === 'invalid') {
      onUpdatePageStateRef.current(browserTabId, { loadError: submission.loadError })
      return
    }
    navigateToUrl(submission.url)
  }

  const handleInternalFileDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes(WORKSPACE_FILE_PATH_MIME)) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const handleInternalFileDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!event.dataTransfer.types.includes(WORKSPACE_FILE_PATH_MIME)) {
        return
      }
      event.preventDefault()
      event.stopPropagation()

      // Why: a browser opens one URL, so reject multi-path drags rather than silently opening the lead file.
      const dragPaths = readWorkspaceFileDragPaths(event.dataTransfer, { maxPaths: 1 })
      if (dragPaths.status === 'rejected') {
        setResourceNotice(getWorkspaceFileDragRejectionMessage(dragPaths.reason))
        return
      }
      const filePath = dragPaths.paths[0]
      if (!filePath) {
        return
      }

      const target = getWorkspaceFileBrowserOpenTarget({ filePath, worktreeId })
      if (target.status === 'unsupported') {
        setResourceNotice(target.message)
        return
      }

      const webview = webviewRef.current
      const rect = webview?.getBoundingClientRect()
      if (!webview || !rect) {
        setResourceNotice(
          translate(
            'auto.components.browser.pane.navigate.use.browser.page.navigation.downloads.8683b84b9e',
            'Browser page is not ready for file drops.'
          )
        )
        return
      }
      const pageX = event.clientX - rect.left
      const pageY = event.clientY - rect.top
      if (pageX < 0 || pageY < 0 || pageX > rect.width || pageY > rect.height) {
        setResourceNotice(
          translate(
            'auto.components.browser.pane.navigate.use.browser.page.navigation.downloads.22272f2784',
            'Drop files over the browser page, not the toolbar.'
          )
        )
        return
      }

      navigateToUrl(target.url)
    },
    [navigateToUrl, setResourceNotice, webviewRef, worktreeId]
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
      const opened = await window.api.shell.openFilePath(download.savePath)
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
      const result = await window.api.shell.openInFileManager(download.savePath)
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
