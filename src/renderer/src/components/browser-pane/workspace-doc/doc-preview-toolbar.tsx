import { useState } from 'react'
import {
  BrowserChromeToolbar,
  type BrowserChromeElementTools,
  type BrowserChromeShareControl
} from '@/components/browser-pane/assemble-chrome/browser-chrome-toolbar'
import { BrowserReloadControl } from '@/components/browser-pane/assemble-chrome/browser-reload-control'
import { translate } from '@/i18n/i18n'
import { DocPreviewAddressEdit } from './doc-preview-address-edit'
import type { DocPreviewDocumentIdentity } from './doc-preview-document-identity'
import type { DocPreviewHistory } from './doc-preview-webview-history'
import { DocPreviewOverflowMenu } from './doc-preview-overflow-menu'

/** Use document identity until editing begins; committed addresses can convert the preview into a URL page. */
export function DocPreviewToolbar({
  identity,
  previewId,
  worktreeId,
  history,
  onReload,
  onHardReload,
  onCopyPath,
  onCopyRelativePath,
  onOpenSource,
  onOpenExternally,
  elementTools,
  markupActive,
  onToggleMarkup,
  markupDisabled,
  shareControl
}: {
  identity: DocPreviewDocumentIdentity
  /** The browser page this preview is open in — what an address commit converts. */
  previewId: string
  worktreeId: string
  history: DocPreviewHistory
  onReload: () => void
  /** Drops the grant and mints a new one — the preview's equivalent of ignoring every cache. */
  onHardReload: () => void
  onCopyPath: () => void
  onCopyRelativePath: () => void
  onOpenSource: () => void
  onOpenExternally: () => void
  elementTools: BrowserChromeElementTools
  markupActive: boolean
  onToggleMarkup: () => void
  markupDisabled: boolean
  /** Absent for documents a share link can't render. */
  shareControl?: (control: BrowserChromeShareControl) => React.ReactNode
}): React.JSX.Element {
  const [reloadMenuOpen, setReloadMenuOpen] = useState(false)
  const reloadLabel = translate(
    'auto.components.editor.HtmlDocPreview.reloadPreviewControl',
    'Reload preview'
  )

  return (
    <BrowserChromeToolbar
      controls={{
        canGoBack: history.canGoBack,
        canGoForward: history.canGoForward,
        goBack: history.goBack,
        goForward: history.goForward,
        reload: onReload,
        // The custom address slot owns submission; the shared chrome callback is unreachable.
        navigate: () => {}
      }}
      addressSlot={
        <DocPreviewAddressEdit identity={identity} previewId={previewId} worktreeId={worktreeId} />
      }
      reloadControl={
        <BrowserReloadControl
          menuOpen={reloadMenuOpen}
          onMenuOpenChange={setReloadMenuOpen}
          label={reloadLabel}
          showShortcutHint={false}
          reloadShortcut=""
          hardReloadShortcut=""
          onPrimary={onReload}
          onReload={onReload}
          onHardReload={onHardReload}
        />
      }
      // Preview grants read workspace disk without a browsing session to receive imported cookies.
      importControl={null}
      elementTools={elementTools}
      markup={{
        active: markupActive,
        disabled: markupDisabled,
        onToggle: onToggleMarkup,
        // Reserve the once-per-install draw hint for browsing panes.
        canShowDiscoveryHint: false
      }}
      shareControl={shareControl}
      viewSource={{
        onSelect: onOpenSource,
        label: translate(
          'auto.components.editor.HtmlDocPreview.openSourceControl',
          'Open source file'
        ),
        alreadyInOverflowMenu: true
      }}
      openExternal={{
        onSelect: onOpenExternally,
        label: translate(
          'auto.components.editor.HtmlDocPreview.openExternallyControl',
          'Open with default app'
        )
      }}
      overflowMenu={(overflow) => (
        <DocPreviewOverflowMenu
          onReload={onReload}
          onHardReload={onHardReload}
          onOpenSource={onOpenSource}
          onCopyPath={onCopyPath}
          onCopyRelativePath={onCopyRelativePath}
          overflow={overflow}
        />
      )}
    />
  )
}
