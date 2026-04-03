import React from 'react'
import { Code, Eye } from 'lucide-react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { MarkdownViewMode } from '@/store/slices/editor'

type MarkdownViewToggleProps = {
  mode: MarkdownViewMode
  onChange: (mode: MarkdownViewMode) => void
}

export default function MarkdownViewToggle({
  mode,
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
      <ToggleGroupItem value="source" aria-label="Source" title="Source">
        <Code className="h-2 w-2" />
      </ToggleGroupItem>
      <ToggleGroupItem value="rich" aria-label="Rich" title="Rich">
        <Eye className="h-2 w-2" />
      </ToggleGroupItem>
    </ToggleGroup>
  )
}
