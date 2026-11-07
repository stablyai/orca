import { getStructuredAgentSessionTabsByPaneKey } from '@/components/native-chat/structured-agent-session-tabs'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import { buildWorktreeAgentRows } from '../sidebar/workspace-card/activity/worktree-agent-rows'
import type { BuildActivityEventsArgs } from './activity-event-builder'
import {
    resolveActivityEventOwner,
    type ActivityEventOwner,
    type ActivityTabHostIndex
} from './activity-event-builder-context'
import { isStandaloneActivityWorktree } from './activity-standalone-worktree'

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

function supplementedRowHostEntry(
    rowEntry: AgentStatusEntry,
    agentStatusByPaneKey: Record<string, AgentStatusEntry>,
    paneEntryByPaneKey: Record<string, AgentStatusEntry>
): AgentStatusEntry {
    const parentPaneKey = rowEntry.orchestration?.parentPaneKey
    if (!parentPaneKey) {
        return rowEntry
    }
    return agentStatusByPaneKey[parentPaneKey] ?? paneEntryByPaneKey[parentPaneKey] ?? rowEntry
}

/** Card rows the hook scan never emits: title-derived sessions and in-process subagents. */
export function appendCardVisibleLiveAgents(args: {
    build: BuildActivityEventsArgs
    liveAgentByPaneKey: Record<string, ActivityLiveAgentSnapshot>
    paneEntryByPaneKey: Record<string, AgentStatusEntry>
    tabHostIndex: ActivityTabHostIndex
    ownerCache: Map<string, ActivityEventOwner>
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
        const owner = resolveActivityEventOwner(
            build,
            { worktreeId: row.tab.worktreeId, tab: row.tab },
            supplementedRowHostEntry(
                row.entry,
                build.agentStatusByPaneKey,
                args.paneEntryByPaneKey
            ),
            row.tab.ptyId,
            args.tabHostIndex,
            args.ownerCache
        )
        if (!owner.knownWorktree || isStandaloneActivityWorktree(owner.worktree)) {
            continue
        }
        args.liveAgentByPaneKey[row.paneKey] = {
            state,
            timestamp: row.entry.stateStartedAt,
            worktree: owner.worktree,
            repo: owner.repo,
            entry: row.entry,
            tab: row.tab,
            agentType: row.agentType
        }
        args.paneEntryByPaneKey[row.paneKey] ??= row.entry
    }
}
