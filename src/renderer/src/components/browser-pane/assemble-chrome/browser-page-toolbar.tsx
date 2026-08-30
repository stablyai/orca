import type { Dispatch, RefObject, SetStateAction } from 'react'
import { ArtifactPublishButton } from '@/components/artifacts/ArtifactPublishButton'
import { translate } from '@/i18n/i18n'
import type { BrowserReloadTrigger } from '../navigate/browser-reload-action'
import BrowserAddressBar from './BrowserAddressBar'
import { BrowserChromeToolbar } from './browser-chrome-toolbar'
import { BrowserImportHintButton } from './BrowserImportHintButton'
import { BrowserReloadControl } from './browser-reload-control'
import { BrowserToolbarMenu } from './BrowserToolbarMenu'
import { SshEgressIndicator } from './browser-egress-indicator'
import { destroyPersistentWebview } from '../host-guest/webview-registry'
import { readBrowserHtmlArtifactRequest } from '../describe-page/browser-artifact-upload'
import type { GrabModeHook } from '../annotate/useGrabMode'
import type {
  BrowserPageConversionOrigin,
  BrowserViewportPresetId
} from '../../../../../shared/browser-workspace-types'
import {
  advanceAcrossBrowserPageConversion,
  returnAcrossBrowserPageConversion
} from '@/lib/browser-page-conversion-history'
import { convertBrowserPageToWorkspaceDoc } from '@/lib/file-preview'
import type { GrabIntent } from '../describe-page/browser-page-types'

/** Binds the shared browser chrome to a browsing page: an editable address bar and session tools. */
export function BrowserPageToolbar({
  browserPageId,
  workspaceId,
  worktreeId,
  sessionProfileId,
  viewportPresetId,
  isActive,
  canGoBack,
  canGoForward,
  convertedFrom,
  convertedTo,
  loading,
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
  canGoBack: boolean
  canGoForward: boolean
  /** Set on a page the address bar converted; Back returns across it once guest history runs out. */
  convertedFrom?: BrowserPageConversionOrigin | null
  /** Set on a page Back returned to; Forward re-crosses it once guest history runs out. */
  convertedTo?: BrowserPageConversionOrigin | null
  loading: boolean
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
  shareableArtifactFile: { filePath: string } | null
  currentBrowserUrl: string
  externalUrl: string | null
}): React.JSX.Element {
  return (
    <BrowserChromeToolbar
      showTourAnchors
      controls={{
        canGoBack: canGoBack || Boolean(convertedFrom),
        canGoForward: canGoForward || Boolean(convertedTo),
        loading,
        // Why the fallbacks: guest history cannot survive a conversion (the guest was replaced),
        // so once it runs out Back returns across the conversion — and Forward re-crosses it —
        // instead of going dead.
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
        />
      }
      reloadControl={
        <BrowserReloadControl
          menuOpen={reloadMenuOpen}
          onMenuOpenChange={setReloadMenuOpen}
          label={reloadButtonLabel}
          loading={loading}
          showShortcutHint={reloadButtonLabelKind === 'reload'}
          reloadShortcut={reloadShortcut}
          hardReloadShortcut={hardReloadShortcut}
          onPrimary={() => runReloadTrigger('button')}
          onReload={() => runReloadTrigger('reload')}
          onHardReload={() => runReloadTrigger('hard-reload')}
        />
      }
      importControl={<BrowserImportHintButton profileId={sessionProfileId} />}
      elementTools={{
        activeIntent: grab.state !== 'idle' ? grabIntent : null,
        onStartIntent: startGrabIntent,
        disabled: isBlankTab || markupIsActive,
        grabShortcutLabel: grabElementShortcut,
        annotationCount: browserAnnotationsLength
      }}
      markup={{
        active: markupIsActive,
        disabled: isBlankTab || grab.state !== 'idle',
        onToggle: () => (markupIsActive ? markupCancel() : void markupStart()),
        canShowDiscoveryHint: isActive
      }}
      shareControl={
        shareableArtifactFile ? (
          <ArtifactPublishButton
            sourceKey={shareableArtifactFile.filePath}
            className="h-7 w-7"
            createRequest={() => readBrowserHtmlArtifactRequest(currentBrowserUrl)}
          />
        ) : null
      }
      viewSource={{
        onSelect: () => void window.api.browser.openDevTools({ browserPageId }),
        label: translate(
          'auto.components.browser.pane.BrowserPane.ec75d0c412',
          'Open browser devtools'
        )
      }}
      openExternal={{
        onSelect: () => {
          if (!externalUrl) {
            return
          }
          void window.api.shell.openUrl(externalUrl)
        },
        label: translate(
          'auto.components.browser.pane.BrowserPane.0f41bf80c7',
          'Open in default browser'
        ),
        disabled: !externalUrl
      }}
      overflowMenu={
        <BrowserToolbarMenu
          currentProfileId={sessionProfileId}
          workspaceId={workspaceId}
          browserPageId={browserPageId}
          viewportPresetId={viewportPresetId}
          onDestroyWebview={() => destroyPersistentWebview(browserPageId)}
          isActive={isActive}
        />
      }
    />
  )
}
