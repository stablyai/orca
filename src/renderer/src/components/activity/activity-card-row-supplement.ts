import { getStructuredAgentSessionTabsByPaneKey } from '@/components/native-chat/structured-agent-session-tabs'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import { buildWorktreeAgentRows } from '../sidebar/workspace-card/activity/worktree-agent-rows'
import type { BuildActivityEventsArgs } from './activity-event-builder'
import type { ActivityLiveAgentSnapshot, ActivityLiveAgentState } from './activity-thread-types'

function cardRowLiveState(row: {
    state: string
    entry: AgentStatusEntry
}): ActivityLiveAgentState | null {
    if (row.state === 'working' && row.entry.workingMode === 'monitoring') {
        return 'monitoring'
    }
    if (row.state === 'working' || row.state === 'blocked' || row.state === 'waiting') {
        return row.state
    }
    return null
}

/** Card rows the hook scan never emits: title-derived sessions and in-process subagents. */
export function appendCardVisibleLiveAgents(args: {
    build: BuildActivityEventsArgs
    liveAgentByPaneKey: Record<string, ActivityLiveAgentSnapshot>
    paneEntryByPaneKey: Record<string, AgentStatusEntry>
}): void {
    const { build } = args
    if (
        build.ptyIdsByTabId === undefined &&
        build.runtimePaneTitlesByTabId === undefined &&
        build.terminalLayoutsByTabId === undefined &&
        build.paneForegroundAgentByPaneKey === undefined
    ) {
        return
    }

    const tabs = Object.values(build.tabsByWorktree).flat()
    if (tabs.length === 0) {
        return
    }

    const rows = buildWorktreeAgentRows({
        tabs,
        representedTabs: build.unifiedTabsByWorktree
            ? getStructuredAgentSessionTabsByPaneKey(build.unifiedTabsByWorktree)
            : undefined,
        entries: Object.values(build.agentStatusByPaneKey),
        retained: Object.values(build.retainedAgentsByPaneKey),
        runtimePaneTitlesByTabId: build.runtimePaneTitlesByTabId,
        ptyIdsByTabId: build.ptyIdsByTabId,
        terminalLayoutsByTabId: build.terminalLayoutsByTabId,
        runtimeAgentOrchestrationByPaneKey: build.runtimeAgentOrchestrationByPaneKey,
        paneForegroundAgentByPaneKey: build.paneForegroundAgentByPaneKey,
        now: build.now
    })

    for (const row of rows) {
        if (args.liveAgentByPaneKey[row.paneKey]) {
            continue
        }
        const state = cardRowLiveState(row)
        if (!state) {
            continue
        }
        const worktree =
            build.worktreeMap.get(row.tab.worktreeId) ?? build.resolveWorktree?.(row.tab.worktreeId)
        if (!worktree) {
            continue
        }
        args.liveAgentByPaneKey[row.paneKey] = {
            state,
            timestamp: row.entry.stateStartedAt,
            worktree,
            repo: build.repoMap.get(worktree.repoId) ?? null,
            entry: row.entry,
            tab: row.tab,
            agentType: row.agentType
        }
        args.paneEntryByPaneKey[row.paneKey] ??= row.entry
    }
}
