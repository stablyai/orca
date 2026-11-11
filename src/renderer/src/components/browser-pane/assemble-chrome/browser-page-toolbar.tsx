import type { Dispatch, RefObject, SetStateAction } from 'react'
import { ArtifactPublishButton } from '@/components/artifacts/ArtifactPublishButton'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { useAppStore } from '@/store'
import type { BrowserReloadTrigger } from '../navigate/browser-reload-action'
import BrowserAddressBar from './BrowserAddressBar'
import { BrowserChromeToolbar } from './browser-chrome-toolbar'
import { BrowserPasswordSaveButton } from '../passwords/BrowserPasswordSaveButton'
import { BrowserReloadControl } from './browser-reload-control'
import { BrowserToolbarMenu } from './BrowserToolbarMenu'
import { BrowserExtensionToolbar, BrowserExtensionsMenuSub } from './browser-extension-toolbar'
import { BrowserOpenSourceFileButton, BrowserPageStateChips } from './browser-address-chips'
import { useBrowserExtensionToolbar } from './use-browser-extension-toolbar'
import { SshEgressIndicator } from './browser-egress-indicator'
import { destroyPersistentWebview } from '../host-guest/webview-registry'
import {
  getShareableBrowserArtifactFile,
  readBrowserHtmlArtifactRequest
} from '../describe-page/browser-artifact-upload'
import {
  canOpenBrowserFileInWorkspaceEditor,
  openBrowserFileSource
} from '../navigate/browser-file-editor-open'
import type { GrabModeHook } from '../annotate/useGrabMode'
import type {
  BrowserPageConversionOrigin,
  BrowserViewportPresetId
} from '../../../../../shared/browser-workspace-types'
import {
  advanceAcrossBrowserPageConversion,
  returnAcrossBrowserPageConversion
} from '@/lib/browser/history/browser-page-conversion-history'
import '@/lib/browser/documents/file-preview'
import { convertBrowserPageToWorkspaceDoc } from '@/lib/browser/documents/file-preview-page-conversion'
import type { GrabIntent } from '../../../../../shared/browser/element-grab/browser-grab-types'
import type { BrowserChromeNoteActions } from './browser-chrome-toolbar'

/** Binds the shared browser chrome to a browsing page: an editable address bar and session tools. */
export function BrowserPageToolbar({
  browserPageId,
  workspaceId,
  worktreeId,
  sessionProfileId,
  viewportPresetId,
  isActive,
  inputLocked,
  canGoBack,
  canGoForward,
  convertedFrom,
  convertedTo,
  loading,
  loadFailed,
  webviewRef,
  reloadMenuOpen,
  setReloadMenuOpen,
  reloadButtonLabel,
  reloadButtonLabelKind,
  reloadShortcut,
  hardReloadShortcut,
  runReloadTrigger,
  addressBarValue,
  setAddressBarValue,
  submitAddressBar,
  navigateToUrl,
  addressBarInputRef,
  dismissAddressBarSuggestionsRef,
  grab,
  grabIntent,
  startGrabIntent,
  isBlankTab,
  markupIsActive,
  markupStart,
  markupCancel,
  grabElementShortcut,
  browserAnnotationsLength,
  notes,
  onOpenFind,
  shareableArtifactFile,
  currentBrowserUrl,
  externalUrl
}: {
  browserPageId: string
  workspaceId: string
  worktreeId: string
  sessionProfileId: string | null
  viewportPresetId: BrowserViewportPresetId | null
  isActive: boolean
  inputLocked: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** Set on a page the address bar converted; Back returns across it once guest history runs out. */
  convertedFrom?: BrowserPageConversionOrigin | null
  /** Set on a page Back returned to; Forward re-crosses it once guest history runs out. */
  convertedTo?: BrowserPageConversionOrigin | null
  loading: boolean
  loadFailed: boolean
  webviewRef: RefObject<Electron.WebviewTag | null>
  reloadMenuOpen: boolean
  setReloadMenuOpen: Dispatch<SetStateAction<boolean>>
  reloadButtonLabel: string
  reloadButtonLabelKind: 'stop' | 'retry' | 'reload'
  reloadShortcut: string
  hardReloadShortcut: string
  runReloadTrigger: (trigger: BrowserReloadTrigger) => void
  addressBarValue: string
  setAddressBarValue: Dispatch<SetStateAction<string>>
  submitAddressBar: () => void
  navigateToUrl: (url: string) => void
  addressBarInputRef: RefObject<HTMLInputElement | null>
  dismissAddressBarSuggestionsRef: RefObject<(() => void) | null>
  grab: GrabModeHook
  grabIntent: GrabIntent
  startGrabIntent: (intent: GrabIntent) => void
  isBlankTab: boolean
  markupIsActive: boolean
  markupStart: () => Promise<void>
  markupCancel: () => void
  grabElementShortcut: string
  browserAnnotationsLength: number
  notes: BrowserChromeNoteActions
  onOpenFind: () => void
  shareableArtifactFile: { filePath: string } | null
  currentBrowserUrl: string
  externalUrl: string | null
}): React.JSX.Element {
  const annotateElementShortcut = useShortcutLabel('browser.annotateElement')
  const browserTourStep = useAppStore((state) =>
    state.activeContextualTourId === 'browser' ? state.activeContextualTourStepIndex : null
  )
  const localHtmlFilePath = getShareableBrowserArtifactFile(currentBrowserUrl)?.filePath ?? null
  // Why the URL check first: every other page skips the workspace-owner lookup on each store write.
  const canOpenSourceFile = useAppStore(
    (state) => localHtmlFilePath !== null && canOpenBrowserFileInWorkspaceEditor(state, worktreeId)
  )
  const openSourceFile =
    canOpenSourceFile && localHtmlFilePath !== null
      ? () => openBrowserFileSource(worktreeId, localHtmlFilePath)
      : null
  const extensionToolbar = useBrowserExtensionToolbar(
    browserPageId,
    isActive,
    `${currentBrowserUrl}\n${loading}`
  )

  return (
    <BrowserChromeToolbar
      closeTabOwner={{ worktreeId, browserPageId }}
      showTourAnchors
      pinAnnotateLabel={browserTourStep === 0}
      controls={{
        canGoBack: canGoBack || Boolean(convertedFrom),
        canGoForward: canGoForward || Boolean(convertedTo),
        // Guest replacement loses history; Back/Forward cross the conversion once guest history runs out.
        goBack: () => {
          if (canGoBack) {
            webviewRef.current?.goBack()
            return
          }
          if (convertedFrom) {
            returnAcrossBrowserPageConversion(browserPageId, convertedFrom)
          }
        },
        goForward: () => {
          if (canGoForward) {
            webviewRef.current?.goForward()
            return
          }
          if (convertedTo) {
            advanceAcrossBrowserPageConversion(browserPageId, convertedTo)
          }
        },
        reload: () => runReloadTrigger('button'),
        navigate: navigateToUrl
      }}
      addressSlot={
        <BrowserAddressBar
          disabled={inputLocked}
          pageId={browserPageId}
          value={addressBarValue}
          onChange={setAddressBarValue}
          onSubmit={submitAddressBar}
          onNavigate={navigateToUrl}
          onOpenWorkspaceDoc={(docLocation) =>
            convertBrowserPageToWorkspaceDoc(browserPageId, docLocation)
          }
          inputRef={addressBarInputRef}
          dismissSuggestionsRef={dismissAddressBarSuggestionsRef}
          leadingIcon={<SshEgressIndicator worktreeId={worktreeId} />}
          trailing={
            <>
              <BrowserPasswordSaveButton browserPageId={browserPageId} isActive={isActive} />
              <BrowserPageStateChips
                browserPageId={browserPageId}
                url={currentBrowserUrl}
                viewportPresetId={viewportPresetId}
                isActive={isActive}
              />
              {openSourceFile ? <BrowserOpenSourceFileButton onOpen={openSourceFile} /> : null}
              {shareableArtifactFile ? (
                <ArtifactPublishButton
                  sourceKey={shareableArtifactFile.filePath}
                  size="icon-xs"
                  createRequest={() => readBrowserHtmlArtifactRequest(currentBrowserUrl)}
                />
              ) : null}
            </>
          }
          loading={loading}
          loadFailed={loadFailed}
        />
      }
      reloadControl={
        <BrowserReloadControl
          menuOpen={reloadMenuOpen}
          onMenuOpenChange={setReloadMenuOpen}
          label={reloadButtonLabel}
          showStop={reloadButtonLabelKind === 'stop'}
          showShortcutHint={reloadButtonLabelKind === 'reload'}
          reloadShortcut={reloadShortcut}
          hardReloadShortcut={hardReloadShortcut}
          onPrimary={() => runReloadTrigger('button')}
          onReload={() => runReloadTrigger('reload')}
          onHardReload={() => runReloadTrigger('hard-reload')}
        />
      }
      extensionActions={
        extensionToolbar &&
        ((compact, menuTriggerRef) => (
          <BrowserExtensionToolbar
            browserPageId={browserPageId}
            state={extensionToolbar}
            compact={compact}
            fallbackAnchorRef={menuTriggerRef}
          />
        ))
      }
      elementTools={{
        activeIntent: grab.state !== 'idle' ? grabIntent : null,
        onStartIntent: startGrabIntent,
        disabled: isBlankTab || markupIsActive,
        grabShortcutLabel: grabElementShortcut,
        annotateShortcutLabel: annotateElementShortcut,
        annotationCount: browserAnnotationsLength
      }}
      markup={{
        active: markupIsActive,
        disabled: isBlankTab || grab.state !== 'idle',
        onToggle: () => (markupIsActive ? markupCancel() : void markupStart()),
        canShowDiscoveryHint: isActive
      }}
      notes={notes}
      overflowMenu={(overflow) => (
        <BrowserToolbarMenu
          currentProfileId={sessionProfileId}
          workspaceId={workspaceId}
          browserPageId={browserPageId}
          viewportPresetId={viewportPresetId}
          onDestroyWebview={() => destroyPersistentWebview(browserPageId)}
          isActive={isActive}
          isBlankTab={isBlankTab}
          pageActions={{
            onFind: onOpenFind,
            onHardReload: () => runReloadTrigger('hard-reload'),
            onOpenDevTools: () => void window.api.browser.openDevTools({ browserPageId }),
            onOpenExternal: externalUrl ? () => void window.api.shell.openUrl(externalUrl) : null
          }}
          extensionsSub={
            extensionToolbar ? (
              <BrowserExtensionsMenuSub
                browserPageId={browserPageId}
                state={extensionToolbar}
                anchorRef={overflow.triggerRef}
                deferUntilClose={overflow.deferUntilClose}
              />
            ) : null
          }
          overflow={overflow}
        />
      )}
    />
  )
}
