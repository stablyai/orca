import React from 'react'
import { Kanban } from 'lucide-react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { Button } from '@/components/ui/button'
import { selectAppRailWidth } from '@/components/app-rail/app-rail-layout'
import { useAppStore } from '@/store'
import { WorkspaceBoardMovedHint } from './WorkspaceBoardMovedHint'

// A label wider than the sidebar, as a long translation would be, to exercise the left-edge clamp.
const LONG_LABEL = 'The workspace board now lives in the bar along the bottom of the sidebar'

function ShellWithHint({
  railWidth,
  label
}: {
  railWidth: number
  label: string
}): React.JSX.Element {
  const anchorRef = React.useRef<HTMLButtonElement>(null)
  return (
    <div className="flex h-[140px] items-end">
      {railWidth > 0 ? (
        <div
          data-fixture-rail=""
          className="h-full shrink-0 bg-muted"
          style={{ width: railWidth }}
        />
      ) : null}
      <div
        data-sidebar-content-shell=""
        className="relative flex h-full w-[220px] flex-col justify-end overflow-hidden bg-worktree-sidebar"
      >
        <div className="flex justify-end border-t border-worktree-sidebar-border px-2 py-1.5">
          <Button ref={anchorRef} variant="ghost" size="icon-xs" aria-label="Workspace board">
            <Kanban className="size-3.5" />
          </Button>
          <WorkspaceBoardMovedHint id="fixture-moved-hint" open anchorRef={anchorRef}>
            {label}
          </WorkspaceBoardMovedHint>
        </div>
      </div>
      <div className="h-full flex-1 bg-background" />
    </div>
  )
}

export const longLabelWithRail = defineFixture({
  width: 720,
  render: () => <ShellWithHint railWidth={48} label={LONG_LABEL} />
})

export const longLabelNoRail = defineFixture({
  width: 720,
  render: () => <ShellWithHint railWidth={0} label={LONG_LABEL} />
})

function LiveRailShell(): React.JSX.Element {
  // The rail follows the real app setting, so toggling it moves this mounted sidebar without a resize.
  const railWidth = useAppStore(selectAppRailWidth)
  return <ShellWithHint railWidth={railWidth} label={LONG_LABEL} />
}

export const longLabelLiveRail = defineFixture({
  width: 720,
  render: () => <LiveRailShell />
})
