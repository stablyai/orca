import { Copy, ExternalLink, FolderOpen, Link2 } from 'lucide-react'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import type { TerminalContextMenuLinkTarget } from './terminal-context-menu-link-target'

type TerminalContextMenuLinkActionsProps = {
  linkTarget: TerminalContextMenuLinkTarget
  onOpenLinkTarget?: () => void
  onCopyLinkTarget?: () => void
  onRevealLinkTarget?: () => void
}

/** Link/path actions shown at the top of the terminal context menu (#9279). */
export function TerminalContextMenuLinkActions({
  linkTarget,
  onOpenLinkTarget,
  onCopyLinkTarget,
  onRevealLinkTarget
}: TerminalContextMenuLinkActionsProps): React.JSX.Element {
  return (
    <>
      <DropdownMenuItem onSelect={onOpenLinkTarget}>
        {linkTarget.kind === 'http' ? <ExternalLink /> : <Link2 />}
        {linkTarget.kind === 'http'
          ? translate('auto.components.terminal.pane.TerminalContextMenu.openLink', 'Open Link')
          : translate('auto.components.terminal.pane.TerminalContextMenu.openPath', 'Open Path')}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={onCopyLinkTarget}>
        <Copy />
        {linkTarget.kind === 'http'
          ? translate('auto.components.terminal.pane.TerminalContextMenu.copyLink', 'Copy Link')
          : translate('auto.components.terminal.pane.TerminalContextMenu.copyPath', 'Copy Path')}
      </DropdownMenuItem>
      {linkTarget.kind === 'file' ? (
        <DropdownMenuItem onSelect={onRevealLinkTarget}>
          <FolderOpen />
          {translate(
            'auto.components.terminal.pane.TerminalContextMenu.revealInFileManager',
            'Reveal in File Manager'
          )}
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuSeparator />
    </>
  )
}
