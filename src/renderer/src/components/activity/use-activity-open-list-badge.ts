import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { activityOpenListBadge, type ActivityOpenListBadge } from './activity-open-list-badge'
import { useAgentPaneThreads } from './use-agent-pane-threads'

/** Badge reads the same threads the activity list shows before search or unread narrowing. */
export function useActivityOpenListBadge(): ActivityOpenListBadge {
    const showChildAgents = useAppStore((s) => s.agentsShowChildAgents)
    const { visibleThreads } = useAgentPaneThreads({
        query: '',
        readFilter: 'all',
        groupBy: 'status',
        selectedPaneKey: null,
        showChildAgents
    })
    return useMemo(() => activityOpenListBadge(visibleThreads), [visibleThreads])
}
