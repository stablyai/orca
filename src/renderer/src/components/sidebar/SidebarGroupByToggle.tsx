import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type {
  WorktreeGroupBy,
  WorktreeGroupBySecondary
} from '../../../../shared/sidebar-list/row-types'
import { GROUP_BY_OPTIONS, SECONDARY_GROUP_BY_OPTIONS } from './sidebar-workspace-option-items'

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

function isWorktreeGroupBySecondary(value: string): value is WorktreeGroupBySecondary {
  return SECONDARY_GROUP_BY_OPTIONS.some((option) => option.id === value)
}

type SidebarSecondaryGroupByToggleProps = {
  primaryGroupBy: WorktreeGroupBy
  groupBy: WorktreeGroupBySecondary
  setGroupBy: (groupBy: WorktreeGroupBySecondary) => void
}

export function SidebarSecondaryGroupByToggle({
  primaryGroupBy,
  groupBy,
  setGroupBy
}: SidebarSecondaryGroupByToggleProps) {
  return (
    <ToggleGroup
      type="single"
      value={groupBy}
      onValueChange={(value) => {
        if (isWorktreeGroupBySecondary(value)) {
          setGroupBy(value)
        }
      }}
      variant="outline"
      size="sm"
      className="h-6 w-full justify-stretch"
    >
      {SECONDARY_GROUP_BY_OPTIONS.filter((option) => option.id !== primaryGroupBy).map((option) => (
        <ToggleGroupItem
          key={option.id}
          value={option.id}
          onPointerDownCapture={() => setGroupBy(option.id)}
          className="h-6 grow basis-0 px-1 text-[10px] data-[state=on]:bg-foreground/10 data-[state=on]:font-semibold data-[state=on]:text-foreground"
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
