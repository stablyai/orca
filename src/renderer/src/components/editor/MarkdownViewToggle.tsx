import React from 'react'
import { Code, Eye, Pencil } from 'lucide-react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { MarkdownViewMode } from '@/store/slices/editor'

const VIEW_MODE_METADATA = {
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
} as const

type MarkdownViewToggleProps = {
  mode: MarkdownViewMode
  modes: readonly MarkdownViewMode[]
  onChange: (mode: MarkdownViewMode) => void
}

export default function MarkdownViewToggle({
  mode,
  modes,
  onChange
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
        const metadata = VIEW_MODE_METADATA[viewMode]
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
