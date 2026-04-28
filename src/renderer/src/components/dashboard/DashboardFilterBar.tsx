import React from 'react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { DashboardFilter } from './useDashboardFilter'

const FILTERS: { value: DashboardFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'done', label: 'Done' }
]

type Props = {
  value: DashboardFilter
  onChange: (value: DashboardFilter) => void
}

const DashboardFilterBar = React.memo(function DashboardFilterBar({ value, onChange }: Props) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(v) => {
        // ToggleGroup fires empty string when deselecting — keep current filter
        if (v) {
          onChange(v as DashboardFilter)
        }
      }}
      variant="outline"
      size="sm"
      className="gap-0"
    >
      {FILTERS.map((f) => (
        <ToggleGroupItem key={f.value} value={f.value} className="text-[11px] px-2.5 py-1 h-7">
          {f.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
})

export default DashboardFilterBar
