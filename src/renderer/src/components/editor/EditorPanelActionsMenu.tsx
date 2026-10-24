import type React from 'react'
import { FileDown, MoreHorizontal } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

type EditorPanelActionsMenuProps = {
  fileLocationActions?: React.ReactNode
  isDiffSurface: boolean
  /** Diff-only wrap preference; ignored for normal file tabs. */
  diffWordWrap: boolean
  /** Diff-only whitespace preference; ignored for normal file tabs. */
  diffShowWhitespace: boolean
  /** File editor wrap preference (`settings.editorWordWrap`). */
  editorWordWrap: boolean
  shouldShowMarkdownExportAction: boolean
  canExportMarkdownToPdf: boolean
  canShowMarkdownFrontmatterToggle: boolean
  markdownFrontmatterVisible: boolean
  onToggleDiffWordWrap: () => void
  onToggleDiffWhitespace: () => void
  onToggleEditorWordWrap: () => void
  onToggleMarkdownFrontmatter: () => void
  onExportMarkdownToPdf: () => void
}

export function EditorPanelActionsMenu({
  fileLocationActions,
  isDiffSurface,
  diffWordWrap,
  diffShowWhitespace,
  editorWordWrap,
  shouldShowMarkdownExportAction,
  canExportMarkdownToPdf,
  canShowMarkdownFrontmatterToggle,
  markdownFrontmatterVisible,
  onToggleDiffWordWrap,
  onToggleDiffWhitespace,
  onToggleEditorWordWrap,
  onToggleMarkdownFrontmatter,
  onExportMarkdownToPdf
}: EditorPanelActionsMenuProps): React.JSX.Element {
  // Why: normal files always get Word Wrap so long/structured lines can unwrap without Settings (#9974).
  const wordWrapChecked = isDiffSurface ? diffWordWrap : editorWordWrap
  const onToggleWordWrap = isDiffSurface ? onToggleDiffWordWrap : onToggleEditorWordWrap
  const menuLabel = fileLocationActions
    ? translate('auto.components.editor.EditorPanelActionsMenu.fileActions', 'File actions')
    : translate('auto.components.editor.EditorPanelMarkdownActionsMenu.561251019a', 'More actions')

  return (
    <DropdownMenu modal={false}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-xs" aria-label={menuLabel}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {menuLabel}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" sideOffset={4}>
        {fileLocationActions ? (
          <>
            {fileLocationActions}
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuCheckboxItem checked={wordWrapChecked} onCheckedChange={onToggleWordWrap}>
          {translate(
            'auto.components.editor.EditorPanelMarkdownActionsMenu.1eef809708',
            'Word Wrap'
          )}
        </DropdownMenuCheckboxItem>
        {isDiffSurface ? (
          <DropdownMenuCheckboxItem
            checked={diffShowWhitespace}
            onCheckedChange={onToggleDiffWhitespace}
          >
            {translate(
              'auto.components.editor.EditorPanelMarkdownActionsMenu.4dedd55efa',
              'Show Whitespace'
            )}
          </DropdownMenuCheckboxItem>
        ) : null}
        {canShowMarkdownFrontmatterToggle ? (
          <DropdownMenuCheckboxItem
            checked={markdownFrontmatterVisible}
            onCheckedChange={onToggleMarkdownFrontmatter}
          >
            {translate('auto.components.editor.EditorContent.e4b074749d', 'Front Matter')}
          </DropdownMenuCheckboxItem>
        ) : null}
        {shouldShowMarkdownExportAction ? <DropdownMenuSeparator /> : null}
        {shouldShowMarkdownExportAction ? (
          <DropdownMenuItem
            // Why: source/Monaco fallbacks have no rendered document DOM to export.
            disabled={!canExportMarkdownToPdf}
            onSelect={onExportMarkdownToPdf}
          >
            <FileDown />
            {translate(
              'auto.components.editor.EditorPanelMarkdownActionsMenu.3e0ce48c24',
              'Export as PDF'
            )}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
