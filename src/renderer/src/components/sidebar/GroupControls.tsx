import React from 'react'
import { useAppStore } from '@/store'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

const GroupControls = React.memo(function GroupControls() {
  const groupBy = useAppStore((s) => s.groupBy)
  const setGroupBy = useAppStore((s) => s.setGroupBy)

  return (
    <div className="flex items-center justify-between px-2 pb-1.5 gap-1">
      <ToggleGroup
        type="single"
        value={groupBy}
        onValueChange={(v) => {
          if (v) {
            setGroupBy(v as typeof groupBy)
          }
        }}
        variant="outline"
        size="sm"
        className="h-6 flex-1 justify-start"
      >
        <ToggleGroupItem
          value="none"
          className="h-6 px-2 text-[10px] data-[state=on]:bg-foreground/10 data-[state=on]:font-semibold data-[state=on]:text-foreground"
        >
          All
        </ToggleGroupItem>
        <ToggleGroupItem
          value="pr-status"
          className="h-6 px-2 text-[10px] data-[state=on]:bg-foreground/10 data-[state=on]:font-semibold data-[state=on]:text-foreground"
        >
          PR Status
        </ToggleGroupItem>
        <ToggleGroupItem
          value="repo"
          className="h-6 px-2 text-[10px] data-[state=on]:bg-foreground/10 data-[state=on]:font-semibold data-[state=on]:text-foreground"
        >
          Repo
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  )
})

export default GroupControls
