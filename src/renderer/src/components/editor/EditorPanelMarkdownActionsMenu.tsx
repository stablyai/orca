import type React from 'react'
import { MoreHorizontal } from 'lucide-react'
import type { MarkdownViewMode } from '@/store/slices/editor'
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
  hasViewModeToggle: boolean
  mdViewMode: MarkdownViewMode
  canShowMarkdownFrontmatterToggle: boolean
  markdownFrontmatterVisible: boolean
  onToggleMarkdownFrontmatter: () => void
  onExportMarkdownToPdf: () => void
}

export function EditorPanelMarkdownActionsMenu({
  isMarkdown,
  hasViewModeToggle,
  mdViewMode,
  canShowMarkdownFrontmatterToggle,
  markdownFrontmatterVisible,
  onToggleMarkdownFrontmatter,
  onExportMarkdownToPdf
}: EditorPanelMarkdownActionsMenuProps): React.JSX.Element | null {
  if (!isMarkdown || (!hasViewModeToggle && !canShowMarkdownFrontmatterToggle)) {
    return null
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
          aria-label={translate("auto.components.editor.EditorPanelMarkdownActionsMenu.561251019a", "More actions")}
          title={translate("auto.components.editor.EditorPanelMarkdownActionsMenu.561251019a", "More actions")}
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
              {markdownFrontmatterVisible ? translate("auto.components.editor.EditorPanelMarkdownActionsMenu.10c39d58c1", "Hide front matter") : translate("auto.components.editor.EditorPanelMarkdownActionsMenu.8c8b7f5ff5", "Show front matter")}
            </DropdownMenuItem>
            {hasViewModeToggle ? <DropdownMenuSeparator /> : null}
          </>
        ) : null}
        {hasViewModeToggle ? (
          <DropdownMenuItem
            // Why: source/Monaco mode has no document DOM. Avoid polling the
            // portal-mounted menu; exportActiveMarkdownToPdf is a safe no-op
            // when no rendered markdown subtree is found.
            disabled={mdViewMode === 'source'}
            onSelect={onExportMarkdownToPdf}
          >
            {translate("auto.components.editor.EditorPanelMarkdownActionsMenu.3e0ce48c24", "Export as PDF")}</DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
