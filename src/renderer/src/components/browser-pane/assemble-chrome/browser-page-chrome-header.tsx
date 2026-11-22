import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react'
import type { BrowserPage as BrowserPageState } from '../../../../../shared/browser/workspaces/browser-workspace-types'
import type { ShareableBrowserArtifactFile } from '../describe-page/browser-artifact-upload'
import type { GrabModeHook } from '../annotate/grab/useGrabMode'
import { BrowserPageToolbar } from './browser-page-toolbar'
import { BrowserPageDownloadList } from '../navigate/browser-page-download-list'
import { BrowserPageChromeBanners } from './feedback/browser-page-chrome-banners'
import type { useBrowserPageReloadActions } from '../navigate/use-browser-page-reload-actions'
import type { useBrowserPageNavigationDownloads } from '../navigate/use-browser-page-navigation-downloads'
import type { useBrowserPageGrabAnnotations } from '../annotate/grab/use-browser-page-grab-annotations'
import type { useBrowserPageAnnotationSend } from '../annotate/delivery/use-browser-page-annotation-send'
import type {
  BrowserChromeElementTools,
  BrowserChromeNoteActions
} from './toolbar/browser-annotate-tool-button'

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
  elementTools,
  notes,
  onOpenFind,
  markupIsActive,
  markupStart,
  markupCancel,
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
  elementTools: BrowserChromeElementTools
  notes: BrowserChromeNoteActions
  onOpenFind: () => void
  markupIsActive: boolean
  markupStart: () => Promise<void>
  markupCancel: () => void
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
        convertedFrom={browserTab.convertedFrom ?? null}
        convertedTo={browserTab.convertedTo ?? null}
        loading={browserTab.loading}
        loadFailed={browserTab.loadError !== null}
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
        elementTools={elementTools}
        grabIdle={grab.state === 'idle'}
        isBlankTab={isBlankTab}
        markupIsActive={markupIsActive}
        markupStart={markupStart}
        markupCancel={markupCancel}
        notes={notes}
        onOpenFind={onOpenFind}
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
        tools={{ grab, grabAnnotations, annotationSend }}
        worktreeId={worktreeId}
      />
    </div>
  )
}
