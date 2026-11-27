import { defineFixture } from '../../../component-fixtures/component-fixture'
import { TooltipProvider } from '@/components/ui/tooltip'
import SidebarToolbar from './SidebarToolbar'

const HINT_SEEN_KEY = 'orca.workspaceBoardMovedHintSeen.v1'
const ELIGIBLE_STORE = {
  persistedUIReady: true,
  featureInteractions: { 'workspace-board': { firstInteractedAt: 1, interactionCount: 1 } },
  workspaceBoardUsedBeforeLaunch: true
}

function SidebarFooter({
  width,
  inset = 24
}: {
  width: number
  inset?: number
}): React.JSX.Element {
  // Mirrors the sidebar shell: clipped column with the toolbar pinned to the bottom.
  return (
    <TooltipProvider>
      <div className="flex h-[120px] items-end" style={{ paddingLeft: inset }}>
        <div
          data-sidebar-content-shell=""
          className="relative flex h-full flex-col overflow-hidden bg-worktree-sidebar"
          style={{ width }}
        >
          <div className="relative mt-auto shrink-0">
            <SidebarToolbar workspaceBoardOpen={false} onWorkspaceBoardToggle={() => {}} />
          </div>
        </div>
        <div className="h-full flex-1 bg-background" />
      </div>
    </TooltipProvider>
  )
}

function clearHintSeen(): void {
  window.localStorage.removeItem(HINT_SEEN_KEY)
}

export const movedHint = defineFixture({
  width: 520,
  store: ELIGIBLE_STORE,
  setup: clearHintSeen,
  render: () => <SidebarFooter width={280} />
})

export const movedHintNarrow = defineFixture({
  width: 520,
  store: ELIGIBLE_STORE,
  setup: clearHintSeen,
  render: () => <SidebarFooter width={220} />
})

/** A window narrower than the bubble: it wraps and never crosses the sidebar's left edge. */
export const movedHintNarrowWindow = defineFixture({
  width: 240,
  store: ELIGIBLE_STORE,
  setup: clearHintSeen,
  render: () => <SidebarFooter width={220} inset={20} />
})
