import type React from 'react'
import { MoreHorizontal } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'

type EditorPanelMarkdownActionsMenuProps = {
  isMarkdown: boolean
  shouldShowMarkdownExportAction: boolean
  canExportMarkdownToPdf: boolean
  canShowMarkdownFrontmatterToggle: boolean
  markdownFrontmatterVisible: boolean
  onToggleMarkdownFrontmatter: () => void
  onExportMarkdownToPdf: () => void
}

export function EditorPanelMarkdownActionsMenu({
  isMarkdown,
  shouldShowMarkdownExportAction,
  canExportMarkdownToPdf,
  canShowMarkdownFrontmatterToggle,
  markdownFrontmatterVisible,
  onToggleMarkdownFrontmatter,
  onExportMarkdownToPdf
}: EditorPanelMarkdownActionsMenuProps): React.JSX.Element | null {
  if (!isMarkdown || (!shouldShowMarkdownExportAction && !canShowMarkdownFrontmatterToggle)) {
    return null
  }

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
