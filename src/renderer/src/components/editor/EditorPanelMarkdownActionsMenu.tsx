import type React from 'react'
import { MoreHorizontal } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'

type EditorPanelMarkdownActionsMenuProps = {
  isMarkdown: boolean
  isDiffSurface: boolean
  /** Diff-only wrap preference; ignored for normal file tabs. */
  diffWordWrap: boolean
  /** File editor wrap preference (`settings.editorWordWrap`). */
  editorWordWrap: boolean
  /** Whether the resolved direction for this file is RTL. */
  textDirectionRtl: boolean
  /** Absent on diff surfaces, where Monaco's LTR-only layout math is not worth fighting. */
  onToggleTextDirection?: () => void
  shouldShowMarkdownExportAction: boolean
  canExportMarkdownToPdf: boolean
  canShowMarkdownFrontmatterToggle: boolean
  markdownFrontmatterVisible: boolean
  onToggleDiffWordWrap: () => void
  onToggleEditorWordWrap: () => void
  onToggleMarkdownFrontmatter: () => void
  onExportMarkdownToPdf: () => void
}

export function EditorPanelMarkdownActionsMenu({
  isMarkdown,
  isDiffSurface,
  diffWordWrap,
  editorWordWrap,
  textDirectionRtl,
  onToggleTextDirection,
  shouldShowMarkdownExportAction,
  canExportMarkdownToPdf,
  canShowMarkdownFrontmatterToggle,
  markdownFrontmatterVisible,
  onToggleDiffWordWrap,
  onToggleEditorWordWrap,
  onToggleMarkdownFrontmatter,
  onExportMarkdownToPdf
}: EditorPanelMarkdownActionsMenuProps): React.JSX.Element | null {
  const hasMarkdownActions =
    isMarkdown && (shouldShowMarkdownExportAction || canShowMarkdownFrontmatterToggle)
  // Why: normal files always get Word Wrap so long/structured lines can unwrap without Settings (#9974).
  const wordWrapChecked = isDiffSurface ? diffWordWrap : editorWordWrap
  const onToggleWordWrap = isDiffSurface ? onToggleDiffWordWrap : onToggleEditorWordWrap

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
          aria-label={translate(
            'auto.components.editor.EditorPanelMarkdownActionsMenu.561251019a',
            'More actions'
          )}
          title={translate(
            'auto.components.editor.EditorPanelMarkdownActionsMenu.561251019a',
            'More actions'
          )}
        >
          <MoreHorizontal size={14} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={4}>
        <DropdownMenuCheckboxItem checked={wordWrapChecked} onCheckedChange={onToggleWordWrap}>
          {translate(
            'auto.components.editor.EditorPanelMarkdownActionsMenu.1eef809708',
            'Word Wrap'
          )}
        </DropdownMenuCheckboxItem>
        {onToggleTextDirection ? (
          <DropdownMenuCheckboxItem
            checked={textDirectionRtl}
            onCheckedChange={onToggleTextDirection}
          >
            {translate(
              'auto.components.editor.EditorPanelMarkdownActionsMenu.86c8a19192',
              'Right-to-Left'
            )}
          </DropdownMenuCheckboxItem>
        ) : null}
        {hasMarkdownActions ? <DropdownMenuSeparator /> : null}
        {canShowMarkdownFrontmatterToggle ? (
          <>
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault()
                onToggleMarkdownFrontmatter()
              }}
            >
              {markdownFrontmatterVisible
                ? translate(
                    'auto.components.editor.EditorPanelMarkdownActionsMenu.10c39d58c1',
                    'Hide front matter'
                  )
                : translate(
                    'auto.components.editor.EditorPanelMarkdownActionsMenu.8c8b7f5ff5',
                    'Show front matter'
                  )}
            </DropdownMenuItem>
            {shouldShowMarkdownExportAction ? <DropdownMenuSeparator /> : null}
          </>
        ) : null}
        {shouldShowMarkdownExportAction ? (
          <DropdownMenuItem
            // Why: source/Monaco fallbacks have no rendered document DOM to export.
            disabled={!canExportMarkdownToPdf}
            onSelect={onExportMarkdownToPdf}
          >
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
