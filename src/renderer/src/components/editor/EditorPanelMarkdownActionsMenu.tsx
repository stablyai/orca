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
  isMarkdownPreviewSurface: boolean
  isRichMarkdownSurface: boolean
  diffWordWrap: boolean
  shouldShowMarkdownExportAction: boolean
  canExportMarkdownToPdf: boolean
  canShowMarkdownFrontmatterToggle: boolean
  markdownFrontmatterVisible: boolean
  markdownPreviewLightBackground: boolean
  onToggleDiffWordWrap: () => void
  onToggleMarkdownFrontmatter: () => void
  onToggleMarkdownPreviewLightBackground: () => void
  onExportMarkdownToPdf: () => void
}

export function EditorPanelMarkdownActionsMenu({
  isMarkdown,
  isDiffSurface,
  isMarkdownPreviewSurface,
  isRichMarkdownSurface,
  diffWordWrap,
  shouldShowMarkdownExportAction,
  canExportMarkdownToPdf,
  canShowMarkdownFrontmatterToggle,
  markdownFrontmatterVisible,
  markdownPreviewLightBackground,
  onToggleDiffWordWrap,
  onToggleMarkdownFrontmatter,
  onToggleMarkdownPreviewLightBackground,
  onExportMarkdownToPdf
}: EditorPanelMarkdownActionsMenuProps): React.JSX.Element | null {
  const isLightBackgroundEligibleSurface =
    !isDiffSurface && (isMarkdownPreviewSurface || isRichMarkdownSurface)
  const hasMarkdownActions =
    isMarkdown &&
    (shouldShowMarkdownExportAction ||
      canShowMarkdownFrontmatterToggle ||
      isLightBackgroundEligibleSurface)
  if (!isDiffSurface && !hasMarkdownActions) {
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
        {isDiffSurface ? (
          <>
            <DropdownMenuCheckboxItem checked={diffWordWrap} onCheckedChange={onToggleDiffWordWrap}>
              {translate(
                'auto.components.editor.EditorPanelMarkdownActionsMenu.1eef809708',
                'Word Wrap'
              )}
            </DropdownMenuCheckboxItem>
            {hasMarkdownActions ? <DropdownMenuSeparator /> : null}
          </>
        ) : null}
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
            {shouldShowMarkdownExportAction && !isLightBackgroundEligibleSurface ? (
              <DropdownMenuSeparator />
            ) : null}
          </>
        ) : null}
        {isMarkdown && isLightBackgroundEligibleSurface ? (
          <>
            <DropdownMenuCheckboxItem
              checked={markdownPreviewLightBackground}
              onCheckedChange={onToggleMarkdownPreviewLightBackground}
            >
              {translate(
                'auto.components.editor.EditorPanelMarkdownActionsMenu.markdownPreviewLightBackground',
                'Light background'
              )}
            </DropdownMenuCheckboxItem>
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
