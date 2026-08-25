import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react'
import type { BrowserPage as BrowserPageState } from '../../../../../shared/browser-workspace-types'
import type { ShareableBrowserArtifactFile } from '../describe-page/browser-artifact-upload'
import type { GrabModeHook } from '../annotate/useGrabMode'
import { BrowserPageToolbar } from './browser-page-toolbar'
import { BrowserPageDownloadList } from '../navigate/browser-page-download-list'
import { BrowserPageChromeBanners } from './browser-page-chrome-banners'
import type { useBrowserPageReloadActions } from '../navigate/use-browser-page-reload-actions'
import type { useBrowserPageNavigationDownloads } from '../navigate/use-browser-page-navigation-downloads'
import type { useBrowserPageGrabAnnotations } from '../annotate/use-browser-page-grab-annotations'
import type { useBrowserPageAnnotationSend } from '../annotate/use-browser-page-annotation-send'

export function BrowserPageChromeHeader({
  chromeHeaderRef,
  browserTab,
  workspaceId,
  worktreeId,
  sessionProfileId,
  isActive,
  webviewRef,
  addressBarInputRef,
  dismissAddressBarSuggestionsRef,
  reload,
  nav,
  grab,
  grabAnnotations,
  annotationSend,
  markupIsActive,
  markupStart,
  markupCancel,
  grabElementShortcut,
  shareableArtifactFile,
  currentBrowserUrl,
  externalUrl,
  isBlankTab,
  resourceNotice,
  setResourceNotice
}: {
  chromeHeaderRef: RefObject<HTMLDivElement | null>
  browserTab: BrowserPageState
  workspaceId: string
  worktreeId: string
  sessionProfileId: string | null
  isActive: boolean
  webviewRef: MutableRefObject<Electron.WebviewTag | null>
  addressBarInputRef: MutableRefObject<HTMLInputElement | null>
  dismissAddressBarSuggestionsRef: MutableRefObject<(() => void) | null>
  reload: ReturnType<typeof useBrowserPageReloadActions>
  nav: ReturnType<typeof useBrowserPageNavigationDownloads>
  grab: GrabModeHook
  grabAnnotations: ReturnType<typeof useBrowserPageGrabAnnotations>
  annotationSend: ReturnType<typeof useBrowserPageAnnotationSend>
  markupIsActive: boolean
  markupStart: () => Promise<void>
  markupCancel: () => void
  grabElementShortcut: string
  shareableArtifactFile: ShareableBrowserArtifactFile | null
  currentBrowserUrl: string
  externalUrl: string | null
  isBlankTab: boolean
  resourceNotice: string | null
  setResourceNotice: Dispatch<SetStateAction<string | null>>
}): React.JSX.Element {
  return (
    <div ref={chromeHeaderRef} className="pointer-events-auto shrink-0">
      <BrowserPageToolbar
        browserPageId={browserTab.id}
        workspaceId={workspaceId}
        worktreeId={worktreeId}
        sessionProfileId={sessionProfileId}
        viewportPresetId={browserTab.viewportPresetId ?? null}
        isActive={isActive}
        canGoBack={browserTab.canGoBack}
        canGoForward={browserTab.canGoForward}
        loading={browserTab.loading}
        webviewRef={webviewRef}
        reloadMenuOpen={reload.reloadMenuOpen}
        setReloadMenuOpen={reload.setReloadMenuOpen}
        reloadButtonLabel={reload.reloadButtonLabel}
        reloadButtonLabelKind={reload.reloadButtonLabelKind}
        reloadShortcut={reload.reloadShortcut}
        hardReloadShortcut={reload.hardReloadShortcut}
        runReloadTrigger={reload.runReloadTrigger}
        addressBarValue={nav.addressBarValue}
        setAddressBarValue={nav.setAddressBarValue}
        submitAddressBar={nav.submitAddressBar}
        navigateToUrl={nav.navigateToUrl}
        addressBarInputRef={addressBarInputRef}
        dismissAddressBarSuggestionsRef={dismissAddressBarSuggestionsRef}
        grab={grab}
        grabIntent={grabAnnotations.grabIntent}
        startGrabIntent={grabAnnotations.startGrabIntent}
        isBlankTab={isBlankTab}
        markupIsActive={markupIsActive}
        markupStart={markupStart}
        markupCancel={markupCancel}
        grabElementShortcut={grabElementShortcut}
        browserAnnotationsLength={annotationSend.browserAnnotations.length}
        shareableArtifactFile={shareableArtifactFile}
        currentBrowserUrl={currentBrowserUrl}
        externalUrl={externalUrl}
      />
      <BrowserPageDownloadList
        visibleDownloads={nav.visibleDownloads}
        onOpenDownloadedFile={nav.handleOpenDownloadedFile}
        onShowDownloadedFile={nav.handleShowDownloadedFile}
        onDismissDownload={nav.dismissBrowserDownload}
      />
      <BrowserPageChromeBanners
        resourceNotice={resourceNotice}
        setResourceNotice={setResourceNotice}
        grab={grab}
        grabIntent={grabAnnotations.grabIntent}
        pendingAnnotationPayload={grabAnnotations.pendingAnnotationPayload}
        browserAnnotationsLength={annotationSend.browserAnnotations.length}
        annotationBannerSendOpen={annotationSend.annotationBannerSendOpen}
        handleAnnotationBannerSendOpenChange={annotationSend.handleAnnotationBannerSendOpenChange}
        worktreeId={worktreeId}
        activeGroupId={annotationSend.activeGroupId}
        browserAnnotationsPrompt={annotationSend.browserAnnotationsPrompt}
        handleBrowserAnnotationsSentToAgent={annotationSend.handleBrowserAnnotationsSentToAgent}
        handleCopyBrowserAnnotations={annotationSend.handleCopyBrowserAnnotations}
        browserAnnotationsCopied={annotationSend.browserAnnotationsCopied}
        handleClearBrowserAnnotations={annotationSend.handleClearBrowserAnnotations}
        setPendingAnnotationPayload={grabAnnotations.setPendingAnnotationPayload}
      />
    </div>
  )
}
