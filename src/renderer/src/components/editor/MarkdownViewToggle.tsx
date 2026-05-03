import React from 'react'
import { Code, Eye, Pencil, Table as TableIcon, type LucideIcon } from 'lucide-react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { MarkdownViewMode } from '@/store/slices/editor'

type ViewModeMetadata = { label: string; icon: LucideIcon }

const DEFAULT_VIEW_MODE_METADATA: Record<MarkdownViewMode, ViewModeMetadata> = {
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

type MarkdownViewToggleProps = {
  mode: MarkdownViewMode
  modes: readonly MarkdownViewMode[]
  onChange: (mode: MarkdownViewMode) => void
  metadataOverride?: Partial<Record<MarkdownViewMode, ViewModeMetadata>>
}

export default function MarkdownViewToggle({
  mode,
  modes,
  onChange,
  metadataOverride
}: MarkdownViewToggleProps): React.JSX.Element {
  return (
    <ToggleGroup
      type="single"
      size="sm"
      className="h-6 [&_[data-slot=toggle-group-item]]:h-7 [&_[data-slot=toggle-group-item]]:min-w-5 [&_[data-slot=toggle-group-item]]:px-2.5"
      variant="outline"
      value={mode}
      onValueChange={(v) => {
        if (v) {
          onChange(v as MarkdownViewMode)
        }
      }}
    >
      {modes.map((viewMode) => {
        const metadata = metadataOverride?.[viewMode] ?? DEFAULT_VIEW_MODE_METADATA[viewMode]
        const Icon = metadata.icon
        return (
          <ToggleGroupItem
            key={viewMode}
            value={viewMode}
            aria-label={metadata.label}
            title={metadata.label}
          >
            <Icon className="h-3 w-3" />
          </ToggleGroupItem>
        )
      })}
    </ToggleGroup>
  )
}
