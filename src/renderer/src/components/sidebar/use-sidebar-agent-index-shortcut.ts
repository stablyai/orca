import { useContext, useEffect } from 'react'
import { ActivityThreadCollapseContext } from '@/components/activity/activity-thread-collapse-context'
import { buildActivityVirtualItems } from '@/components/activity/activity-thread-virtual-items'
import type {
  ActivityGroupBy,
  ActivityThreadGroup,
  AgentPaneThread
} from '@/components/activity/activity-thread-types'

export const SIDEBAR_AGENT_INDEX_JUMP_EVENT = 'orca:sidebar-agent-index-jump'
const EMPTY_COLLAPSED_GROUPS: ReadonlySet<string> = new Set()

export function useSidebarAgentIndexShortcut(
  groups: ActivityThreadGroup[],
  groupBy: ActivityGroupBy,
  selectThread: (thread: AgentPaneThread) => void
): void {
  const collapse = useContext(ActivityThreadCollapseContext)
  const collapsedGroupKeys = collapse?.collapsedGroupKeys ?? EMPTY_COLLAPSED_GROUPS

  useEffect(() => {
    const onJump = (event: Event): void => {
      if (!(event instanceof CustomEvent) || !Number.isInteger(event.detail) || event.detail < 0) {
        return
      }
      // Index the same rows as rendering, not the ungrouped thread array or mounted viewport.
      const items = buildActivityVirtualItems({ groups, groupBy, collapsedGroupKeys })
      const target = items.filter((item) => item.type === 'thread')[event.detail]
      if (target) {
        selectThread(target.thread)
      }
    }
    window.addEventListener(SIDEBAR_AGENT_INDEX_JUMP_EVENT, onJump)
    return () => window.removeEventListener(SIDEBAR_AGENT_INDEX_JUMP_EVENT, onJump)
  }, [groups, groupBy, collapsedGroupKeys, selectThread])
}
