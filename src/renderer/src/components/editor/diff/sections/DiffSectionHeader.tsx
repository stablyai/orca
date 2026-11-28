import { combinedDiffHeaderAttributes } from '../../combined-diff/scroll-viewport/combined-diff-viewport'
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react'
import {
  changedFileOpenLabel,
  type ChangedFileOpenTarget
} from '@/lib/files/open/changed-file-view'
import { ChangedFileOpenIcon } from '@/lib/files/open/ChangedFileOpenIcon'
import type { MouseEvent, ReactElement, ReactNode } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { splitPathForDisplay } from '../../panel/header/editor-path-display'

export function DiffSectionHeader({
  path,
  dirty,
  collapsed,
  added,
  removed,
  onToggle,
  onOpenSection,
  openSectionTitle,
  preview,
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
  /** Opens the working file rendered beside the diff; the target names where it lands. */
  preview?: { target: ChangedFileOpenTarget; onOpen: (event: MouseEvent) => void }
  trailingContent?: ReactNode
}): ReactElement {
  const t = useTranslate()
  const displayPath = splitPathForDisplay(path)
  const sectionToggleLabel = collapsed
    ? t('auto.components.editor.DiffSectionHeader.expandSection', 'Expand {{name}}', {
        name: displayPath.fileName
      })
    : t('auto.components.editor.DiffSectionHeader.collapseSection', 'Collapse {{name}}', {
        name: displayPath.fileName
      })
  return (
    <div
      {...combinedDiffHeaderAttributes}
      className="@container sticky top-0 z-10 bg-background flex items-center w-full px-3 py-1.5 text-left text-xs hover:bg-accent transition-colors group cursor-pointer"
      onClick={onToggle}
    >
      <span className="flex min-w-0 flex-1 items-center text-muted-foreground">
        <span
          role="button"
          tabIndex={0}
          className="flex min-w-0 flex-1 cursor-copy overflow-hidden hover:underline"
          onMouseDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
          }}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            // Stop both mousedown and click so copying the path cannot toggle the parent section.
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
          title={t('auto.components.editor.DiffSectionHeader.8915726e93', 'Copy path')}
        >
          <span className="path-display-prefix">{displayPath.prefix}</span>
          <span className="path-display-file">{displayPath.fileName}</span>
        </span>
        <span className="flex shrink-0 items-center">
          {dirty && <span className="font-medium ml-1">M</span>}
          {(added > 0 || removed > 0) && (
            <span className="diff-section-header-counts tabular-nums ml-2">
              {added > 0 && <span className="text-green-600 dark:text-green-500">+{added}</span>}
              {added > 0 && removed > 0 && <span> </span>}
              {removed > 0 && <span className="text-red-500">-{removed}</span>}
            </span>
          )}
        </span>
      </span>
      <div className="diff-section-header-actions flex items-center gap-1 shrink-0 ml-2">
        {trailingContent}
        {preview != null && (
          <button
            type="button"
            // Keep preview visible for touch and consistent with the single-file header.
            className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors"
            onClick={(event) => {
              event.stopPropagation()
              preview.onOpen(event)
            }}
            title={changedFileOpenLabel(preview.target, t, 'side')}
            aria-label={changedFileOpenLabel(preview.target, t, 'side')}
          >
            <ChangedFileOpenIcon target={preview.target} className="size-3.5" />
          </button>
        )}
        <button
          // Keep open-file visible for touch, matching preview.
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
        <button
          // The header row toggles on click too; this is the control keyboard and screen-reader users reach.
          type="button"
          className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={!collapsed}
          aria-label={sectionToggleLabel}
          title={sectionToggleLabel}
          onClick={(event) => {
            event.stopPropagation()
            onToggle()
          }}
        >
          {collapsed ? (
            <ChevronRight aria-hidden className="size-3.5 shrink-0" />
          ) : (
            <ChevronDown aria-hidden className="size-3.5 shrink-0" />
          )}
        </button>
      </div>
    </div>
  )
}
