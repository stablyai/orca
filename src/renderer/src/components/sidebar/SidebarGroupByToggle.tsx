import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { WorktreeGroupBy } from '../../../../shared/sidebar-list/row-types'
import { GROUP_BY_OPTIONS } from './sidebar-workspace-option-items'

type SidebarGroupByToggleProps = {
  groupBy: WorktreeGroupBy
  setGroupBy: (groupBy: WorktreeGroupBy) => void
}

export function SidebarGroupByToggle({ groupBy, setGroupBy }: SidebarGroupByToggleProps) {
  return (
    <ToggleGroup
      type="single"
      value={groupBy}
      onValueChange={(value) => {
        if (value) {
          setGroupBy(value as WorktreeGroupBy)
        }
      }}
      variant="outline"
      size="sm"
      className="h-6 w-full justify-stretch"
    >
      {GROUP_BY_OPTIONS.map((option) => (
        <ToggleGroupItem
          key={option.id}
          value={option.id}
          // Capture pointer intent before Radix roving focus can consume the click without changing ToggleGroup value.
          onPointerDownCapture={() => setGroupBy(option.id)}
          className="h-6 grow basis-0 px-1 text-[10px] data-[state=on]:bg-foreground/10 data-[state=on]:font-semibold data-[state=on]:text-foreground"
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
