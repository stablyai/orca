import { ChevronDown, ChevronRight, ExternalLink, Eye } from 'lucide-react'
import type { MouseEvent, ReactElement, ReactNode } from 'react'
import { translate } from '@/i18n/i18n'

export function DiffSectionHeader({
  path,
  dirty,
  collapsed,
  added,
  removed,
  onToggle,
  onOpenSection,
  openSectionTitle,
  onOpenPreview,
  trailingContent
}: {
  path: string
  dirty: boolean
  collapsed: boolean
  added: number
  removed: number
  onToggle: () => void
  onOpenSection: (event: MouseEvent) => void
  openSectionTitle: string
  onOpenPreview?: (event: MouseEvent) => void
  trailingContent?: ReactNode
}): ReactElement {
  return (
    <div
      className="sticky top-0 z-10 bg-background flex items-center w-full px-3 py-1.5 text-left text-xs hover:bg-accent transition-colors group cursor-pointer"
      onClick={onToggle}
    >
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        <span
          role="button"
          tabIndex={0}
          className="cursor-copy hover:underline"
          onMouseDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
          }}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            // Why: stop both mouse-down and click on the path affordance so
            // the parent section-toggle row cannot consume the interaction.
            void window.api.ui.writeClipboardText(path).catch((error) => {
              console.error('Failed to copy diff path:', error)
            })
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') {
              return
            }
            event.preventDefault()
            event.stopPropagation()
            void window.api.ui.writeClipboardText(path).catch((error) => {
              console.error('Failed to copy diff path:', error)
            })
          }}
          title={translate('auto.components.editor.DiffSectionHeader.8915726e93', 'Copy path')}
        >
          {path}
        </span>
        {dirty && <span className="font-medium ml-1">M</span>}
        {(added > 0 || removed > 0) && (
          <span className="tabular-nums ml-2">
            {added > 0 && <span className="text-green-600 dark:text-green-500">+{added}</span>}
            {added > 0 && removed > 0 && <span> </span>}
            {removed > 0 && <span className="text-red-500">-{removed}</span>}
          </span>
        )}
      </span>
      <div className="flex items-center gap-1 shrink-0 ml-2">
        {trailingContent}
        {onOpenPreview != null && (
          <button
            type="button"
            // Why: always visible (not hover-reveal) so HTML preview matches the
            // single-file editor header and stays usable without hover (touch).
            className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors"
            onClick={(event) => {
              // Why: header owns stopPropagation so callers cannot forget and toggle the section.
              event.stopPropagation()
              onOpenPreview(event)
            }}
            title={translate(
              'auto.components.editor.EditorPanelHeader.fb8331694e',
              'Open Preview to the Side'
            )}
            aria-label={translate(
              'auto.components.editor.EditorPanelHeader.fb8331694e',
              'Open Preview to the Side'
            )}
          >
            <Eye className="size-3.5" />
          </button>
        )}
        <button
          // Why: always visible so open-file matches Eye preview and works without hover (touch).
          type="button"
          className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors"
          onClick={(event) => {
            event.stopPropagation()
            onOpenSection(event)
          }}
          title={openSectionTitle}
          aria-label={openSectionTitle}
        >
          <ExternalLink className="size-3.5" />
        </button>
        {collapsed ? (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        )}
      </div>
    </div>
  )
}
