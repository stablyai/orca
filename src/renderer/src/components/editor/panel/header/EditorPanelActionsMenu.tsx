import type React from 'react'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { FileDown, MoreHorizontal } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

type EditorPanelActionsMenuProps = {
  encodingFile?: OpenFile
  fileLocationActions?: React.ReactNode
  /** Reload from Disk, in its own group after the file-location items. */
  reloadAction?: React.ReactNode
  isDiffSurface: boolean
  /** Diff-only wrap preference; ignored for normal file tabs. */
  diffWordWrap: boolean
  /** Diff-only whitespace preference; ignored for normal file tabs. */
  diffShowWhitespace: boolean
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
  encodingFile,
  fileLocationActions,
  reloadAction,
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
  const t = useTranslate()
  const setDiffEncoding = useAppStore((state) => state.setDiffEncoding)
  const wordWrapChecked = isDiffSurface ? diffWordWrap : editorWordWrap
  const onToggleWordWrap = isDiffSurface ? onToggleDiffWordWrap : onToggleEditorWordWrap
  const menuLabel = fileLocationActions
    ? t('auto.components.editor.EditorPanelActionsMenu.fileActions', 'File actions')
    : t('auto.components.editor.EditorPanelMarkdownActionsMenu.561251019a', 'More actions')

  return (
    <DropdownMenu modal={false}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={menuLabel}
              data-editor-actions-trigger
            >
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
        {reloadAction ? (
          <>
            {reloadAction}
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuCheckboxItem checked={wordWrapChecked} onCheckedChange={onToggleWordWrap}>
          {t('auto.components.editor.EditorPanelMarkdownActionsMenu.1eef809708', 'Word Wrap')}
        </DropdownMenuCheckboxItem>
        {isDiffSurface ? (
          <DropdownMenuCheckboxItem
            checked={diffShowWhitespace}
            onCheckedChange={onToggleDiffWhitespace}
          >
            {t(
              'auto.components.editor.EditorPanelMarkdownActionsMenu.4dedd55efa',
              'Show Whitespace'
            )}
          </DropdownMenuCheckboxItem>
        ) : null}
        {encodingFile ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={encodingFile.isDirty}>
              {t('auto.components.editor.EditorPanelActionsMenu.textEncoding', 'Text encoding')}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup
                value={encodingFile.diffEncoding ?? 'utf-8'}
                onValueChange={(value) => {
                  if (value === 'utf-8' || value === 'gb18030') {
                    setDiffEncoding(encodingFile.id, value)
                  }
                }}
              >
                <DropdownMenuRadioItem value="utf-8">
                  {t('auto.components.editor.EditorPanelActionsMenu.utf8', 'UTF-8')}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="gb18030">
                  {t(
                    'auto.components.editor.EditorPanelActionsMenu.gb18030',
                    'GBK / GB18030 (read-only)'
                  )}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        {canShowMarkdownFrontmatterToggle ? (
          <DropdownMenuCheckboxItem
            checked={markdownFrontmatterVisible}
            onCheckedChange={onToggleMarkdownFrontmatter}
          >
            {t('auto.components.editor.EditorContent.e4b074749d', 'Front Matter')}
          </DropdownMenuCheckboxItem>
        ) : null}
        {shouldShowMarkdownExportAction ? <DropdownMenuSeparator /> : null}
        {shouldShowMarkdownExportAction ? (
          <DropdownMenuItem
            // Source/Monaco fallbacks have no rendered document DOM to export.
            disabled={!canExportMarkdownToPdf}
            onSelect={onExportMarkdownToPdf}
          >
            <FileDown />
            {t('auto.components.editor.EditorPanelMarkdownActionsMenu.3e0ce48c24', 'Export as PDF')}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
