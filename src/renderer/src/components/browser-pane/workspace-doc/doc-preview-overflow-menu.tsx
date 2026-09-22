import { Copy, FileCode2, MoreHorizontal, RefreshCw, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'

/**
 * The preview's overflow menu. It carries the document actions rather than the browsing pane's
 * profile and viewport rows: a preview has no session to switch and no device to emulate.
 */
export function DocPreviewOverflowMenu({
  onReload,
  onHardReload,
  onOpenSource,
  onCopyPath,
  onCopyRelativePath
}: {
  onReload: () => void
  onHardReload: () => void
  onOpenSource: () => void
  onCopyPath: () => void
  /** Why it lives here: the preview hides the editor's path header, which was the only way to copy it. */
  onCopyRelativePath: () => void
}): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          aria-label={translate(
            'auto.components.editor.HtmlDocPreview.previewMenuControl',
            'Preview options'
          )}
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onReload}>
          <RefreshCw className="size-3.5" />
          {translate('auto.components.browser.pane.BrowserPane.0e080d820e', 'Reload')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onHardReload}>
          <RotateCcw className="size-3.5" />
          {translate('auto.components.browser.pane.BrowserPane.a1f3c2e4b5', 'Hard Reload')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onOpenSource}>
          <FileCode2 className="size-3.5" />
          {translate('auto.components.editor.HtmlDocPreview.openSourceControl', 'Open source file')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onCopyPath}>
          <Copy className="size-3.5" />
          {translate(
            'auto.components.editor.HtmlDocPreview.copyDocumentPathControl',
            'Copy file path'
          )}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onCopyRelativePath}>
          <Copy className="size-3.5" />
          {translate(
            'auto.components.editor.HtmlDocPreview.copyDocumentRelativePathControl',
            'Copy relative path'
          )}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
