import React from 'react'
import {
  Code,
  Eye,
  FileText,
  GitCompareArrows,
  NotebookText,
  Pencil,
  Table as TableIcon,
  type LucideIcon
} from 'lucide-react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { MarkdownViewMode } from '@/store/slices/editor'

// Why: 'changes' is not a MarkdownViewMode in the store — it lives on the
// orthogonal editorViewMode slice. This toggle unifies both dimensions into a
// single segmented control because they are mutually exclusive at render time:
// a file can show Source, Rich, Preview, Edit, OR Changes, but never two at
// once. 'edit' is the code-file counterpart to markdown's 'source' — it means
// "the normal editor for this file" without implying the markdown source/raw
// distinction. See reviews/changes-view-mode-plan.md.
export type EditorToggleValue = MarkdownViewMode | 'edit' | 'changes'

type ViewModeMetadata = { label: string; icon: LucideIcon; title?: string }

const DEFAULT_VIEW_MODE_METADATA: Record<EditorToggleValue, ViewModeMetadata> = {
  source: {
    label: 'Source',
    icon: Code
  },
  rich: {
    label: 'Rich Editor',
    icon: Pencil
  },
  preview: {
    label: 'Preview',
    icon: Eye
  },
  edit: {
    label: 'Edit',
    icon: FileText
  },
  changes: {
    label: 'Changes',
    icon: GitCompareArrows,
    // Why: "Changes" collides with the Source Control sidebar's "Branch
    // Changes" section, which diffs against the base ref. This toggle shows
    // uncommitted changes (working tree vs HEAD), so disambiguate in the
    // hover title without repeating the button label.
    title: 'Uncommitted changes'
  }
}

// Why: CSV/TSV files reuse the 'rich' view mode slot but the rendered surface
// is a read-only table, not an editor. The Pencil icon implies editability,
// which we don't offer, so callers can override the per-mode presentation.
export const CSV_VIEW_MODE_METADATA: Partial<Record<MarkdownViewMode, ViewModeMetadata>> = {
  rich: {
    label: 'Table',
    icon: TableIcon
  }
}

export const NOTEBOOK_VIEW_MODE_METADATA: Partial<Record<MarkdownViewMode, ViewModeMetadata>> = {
  rich: {
    label: 'Notebook',
    icon: NotebookText
  }
}

type EditorViewToggleProps = {
  value: EditorToggleValue
  modes: readonly EditorToggleValue[]
  onChange: (value: EditorToggleValue) => void
  metadataOverride?: Partial<Record<MarkdownViewMode, ViewModeMetadata>>
}

export default function EditorViewToggle({
  value,
  modes,
  onChange,
  metadataOverride
}: EditorViewToggleProps): React.JSX.Element {
  return (
    <TooltipProvider delayDuration={300}>
      <ToggleGroup
        type="single"
        size="sm"
        className="h-6 [&_[data-slot=toggle-group-item]]:h-7 [&_[data-slot=toggle-group-item]]:min-w-5 [&_[data-slot=toggle-group-item]]:px-2.5"
        variant="outline"
        value={value}
        onValueChange={(v) => {
          if (v) {
            onChange(v as EditorToggleValue)
          }
        }}
      >
        {modes.map((viewMode) => {
          // Why: metadataOverride is keyed by MarkdownViewMode (source/rich/preview)
          // because only those slots have language-specific presentation variants
          // (e.g. CSV's "Table" label on the 'rich' slot). 'edit'/'changes' are
          // orthogonal toggle values and always use the default metadata.
          const override = (
            metadataOverride as Partial<Record<EditorToggleValue, ViewModeMetadata>> | undefined
          )?.[viewMode]
          const metadata = override ?? DEFAULT_VIEW_MODE_METADATA[viewMode]
          const Icon = metadata.icon
          const tooltipLabel = metadata.title ?? metadata.label
          return (
            <Tooltip key={viewMode}>
              <TooltipTrigger asChild>
                <ToggleGroupItem
                  value={viewMode}
                  aria-label={metadata.label}
                  className="data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:shadow-xs data-[state=on]:hover:bg-primary/90 data-[state=on]:hover:text-primary-foreground"
                >
                  <Icon className="h-3 w-3" />
                </ToggleGroupItem>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {tooltipLabel}
              </TooltipContent>
            </Tooltip>
          )
        })}
      </ToggleGroup>
    </TooltipProvider>
  )
}
