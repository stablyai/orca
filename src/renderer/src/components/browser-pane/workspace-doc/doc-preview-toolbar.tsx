import { useState } from 'react'
import {
  BrowserChromeToolbar,
  type BrowserChromeElementTools
} from '@/components/browser-pane/assemble-chrome/browser-chrome-toolbar'
import { BrowserReloadControl } from '@/components/browser-pane/assemble-chrome/browser-reload-control'
import { translate } from '@/i18n/i18n'
import { DocPreviewDocumentChip } from './doc-preview-document-chip'
import type { DocPreviewDocumentIdentity } from './doc-preview-document-identity'
import type { DocPreviewHistory } from './doc-preview-webview-history'
import { DocPreviewOverflowMenu } from './doc-preview-overflow-menu'

/**
 * Binds the shared browser chrome to a workspace document: the address bar becomes a read-only
 * identity chip, because a preview shows a path the reader cannot retype into something else.
 */
export function DocPreviewToolbar({
  identity,
  history,
  loading,
  onReload,
  onHardReload,
  onCopyPath,
  onCopyRelativePath,
  onOpenSource,
  onOpenExternally,
  elementTools,
  markupActive,
  onToggleMarkup,
  markupDisabled
}: {
  identity: DocPreviewDocumentIdentity
  history: DocPreviewHistory
  loading: boolean
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
        loading,
        goBack: history.goBack,
        goForward: history.goForward,
        reload: onReload,
        // Why a no-op: the identity chip has nothing to submit, so nothing can reach this.
        navigate: () => {}
      }}
      addressSlot={<DocPreviewDocumentChip identity={identity} />}
      reloadControl={
        <BrowserReloadControl
          menuOpen={reloadMenuOpen}
          onMenuOpenChange={setReloadMenuOpen}
          label={reloadLabel}
          loading={loading}
          showShortcutHint={false}
          reloadShortcut=""
          hardReloadShortcut=""
          onPrimary={onReload}
          onReload={onReload}
          onHardReload={onHardReload}
        />
      }
      // Cookie import is a browsing-session action; a preview reads workspace disk over a grant
      // and has no session for cookies to land in.
      importControl={null}
      elementTools={elementTools}
      markup={{
        active: markupActive,
        disabled: markupDisabled,
        onToggle: onToggleMarkup,
        // Why false on a surface that is plainly visible: the draw-tool nudge fires once per
        // install, and it belongs to the browsing pane. A reader who opened a document should not
        // be the one who spends it.
        canShowDiscoveryHint: false
      }}
      viewSource={{
        onSelect: onOpenSource,
        label: translate(
          'auto.components.editor.HtmlDocPreview.openSourceControl',
          'Open source file'
        )
      }}
      openExternal={{
        onSelect: onOpenExternally,
        label: translate(
          'auto.components.editor.HtmlDocPreview.openExternallyControl',
          'Open with default app'
        )
      }}
      overflowMenu={
        <DocPreviewOverflowMenu
          onReload={onReload}
          onHardReload={onHardReload}
          onOpenSource={onOpenSource}
          onCopyPath={onCopyPath}
          onCopyRelativePath={onCopyRelativePath}
        />
      }
    />
  )
}
