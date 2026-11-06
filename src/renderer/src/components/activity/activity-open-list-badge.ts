import { activityThreadStatusId } from './activity-thread-presentation'
import { activityListSectionId } from './activity-thread-grouping'
import type { AgentPaneThread } from './activity-thread-types'

export type ActivityOpenListBadge = {
    attention: number
    working: number
    count: number
    tone: 'attention' | 'working' | 'idle'
}

/** Count the list as opened: scope and child visibility already applied, search and unread ignored. */
export function activityOpenListBadge(threads: readonly AgentPaneThread[]): ActivityOpenListBadge {
    let attention = 0
    let working = 0
    for (const thread of threads) {
        const section = activityListSectionId(activityThreadStatusId(thread))
        if (section === 'waiting' || section === 'blocked') {
            attention += 1
        } else if (section === 'working') {
            working += 1
        }
    }
    if (attention > 0) {
        return { attention, working, count: attention, tone: 'attention' }
    }
    if (working > 0) {
        return { attention, working, count: working, tone: 'working' }
    }
    return { attention, working, count: 0, tone: 'idle' }
}
