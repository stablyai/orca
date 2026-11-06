import { describe, expect, it } from 'vitest'

import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { TerminalLayoutSnapshot } from '../../../../shared/workspace-layout/terminal-tab-types'
import { buildActivityEvents, type BuildActivityEventsArgs } from './activity-event-builder'
import { activityOpenListBadge } from './activity-open-list-badge'
import { buildAgentPaneThreads } from './activity-thread-builder'
import { translate } from '@/i18n/i18n'
import { buildActivityThreadGroups } from './activity-thread-grouping'
import type { AgentPaneThread } from './activity-thread-types'
import {
    LEAF_ID,
    PANE_KEY,
    makeRepo,
    makeTab,
    makeWorktree
} from './ActivityPrototypePage-test-fixtures'

function layout(): TerminalLayoutSnapshot {
    return {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null
    }
}

function build(cardInputs: boolean, entries: Record<string, AgentStatusEntry> = {}) {
    const repo = makeRepo()
    const worktree = makeWorktree()
    const tab = makeTab()
    const args: BuildActivityEventsArgs = {
        chatNames: new Map(),
        agentStatusByPaneKey: entries,
        retainedAgentsByPaneKey: {},
        tabsByWorktree: { [worktree.id]: [tab] },
        worktreeMap: new Map([[worktree.id, worktree]]),
        repoMap: new Map([[repo.id, repo]]),
        acknowledgedAgentsByPaneKey: {},
        now: 100_000
    }
    if (cardInputs) {
        args.ptyIdsByTabId = { [tab.id]: ['pty-1'] }
        args.runtimePaneTitlesByTabId = { [tab.id]: { 1: 'Codex working' } }
        args.terminalLayoutsByTabId = { [tab.id]: layout() }
    }
    return buildAgentPaneThreads(buildActivityEvents(args))
}

function thread(overrides: Partial<AgentPaneThread>): AgentPaneThread {
    return {
        paneKey: 'pane',
        paneTitle: 'session',
        worktree: makeWorktree(),
        repo: null,
        tab: makeTab(),
        agentType: 'codex',
        currentAgentState: null,
        currentAgentEntry: null,
        responsePreview: '',
        latestTimestamp: 1,
        latestEvent: null,
        events: [],
        unread: false,
        ...overrides
    }
}

describe('activity list card-row supplement', () => {
    it('includes a title-derived working session the card shows when hook status is absent', () => {
        expect(build(false).map((entry) => entry.paneKey)).toEqual([])

        const threads = build(true)
        expect(threads.map((entry) => [entry.paneKey, entry.currentAgentState])).toEqual([
            [PANE_KEY, 'working']
        ])
        expect(
            buildActivityThreadGroups(threads, 'status').map((group) => [group.key, group.label])
        ).toEqual([
            [
                'working',
                translate('auto.components.activity.ActivityPrototypePage.state.working', 'Working')
            ]
        ])
    })

    it('includes a card subagent the hook scan never visits', () => {
        const parent: AgentStatusEntry = {
            state: 'working',
            prompt: 'parent',
            updatedAt: 100_000,
            stateStartedAt: 90_000,
            paneKey: PANE_KEY,
            stateHistory: [],
            agentType: 'codex',
            subagents: [{ id: 'child-1', state: 'working', agentType: 'codex', startedAt: 90_000 }]
        }
        const childKey = `${PANE_KEY}\u0000subagent:child-1`
        expect(build(false, { [PANE_KEY]: parent }).map((entry) => entry.paneKey)).not.toContain(
            childKey
        )
        expect(build(true, { [PANE_KEY]: parent }).map((entry) => entry.paneKey)).toContain(
            childKey
        )
    })

    it('counts the opened working group, including monitoring, and prefers attention', () => {
        const working = thread({ paneKey: 'working', currentAgentState: 'working' })
        const monitoring = thread({ paneKey: 'monitoring', currentAgentState: 'monitoring' })
        const waiting = thread({ paneKey: 'waiting', currentAgentState: 'waiting' })

        expect(
            buildActivityThreadGroups([working, monitoring], 'status').map((group) => group.key)
        ).toEqual(['working'])
        expect(activityOpenListBadge([working, monitoring])).toEqual({
            attention: 0,
            working: 2,
            count: 2,
            tone: 'working'
        })
        expect(activityOpenListBadge([working, waiting])).toEqual({
            attention: 1,
            working: 1,
            count: 1,
            tone: 'attention'
        })
    })
})
