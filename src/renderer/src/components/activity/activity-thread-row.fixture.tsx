import { defineFixture } from '../../component-fixtures/component-fixture'
import { ActivityThreadRow } from './activity-thread-row'
import type { AgentPaneThread } from './activity-thread-types'

function thread(minutesAgo: number, unread: boolean): AgentPaneThread {
  return {
    paneKey: `activity-fixture-${minutesAgo}`,
    paneTitle: 'Make the agent activity timestamp easier to scan',
    worktree: {
      id: 'activity-fixture',
      repoId: 'fixture-repo',
      path: '/projects/orca/activity-timestamp',
      head: 'abc123',
      branch: 'activity-timestamp',
      isBare: false,
      isMainWorktree: false,
      displayName: 'Activity timestamp',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0
    },
    repo: null,
    tab: {
      id: 'fixture-tab',
      ptyId: null,
      worktreeId: 'activity-fixture',
      title: 'Codex',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 0
    },
    agentType: 'codex',
    currentAgentState: 'working',
    currentAgentEntry: null,
    responsePreview: 'Checking the activity card layout in light and dark mode.',
    latestTimestamp: Date.now() - minutesAgo * 60_000,
    latestEvent: null,
    events: [],
    unread
  }
}

function ActivityCards({ compactMode = false }: { compactMode?: boolean }) {
  return (
    <div className="space-y-2 bg-background p-2 text-foreground">
      {[thread(2, true), thread(125, false), thread(3000, false)].map((entry, index) => (
        <ActivityThreadRow
          key={entry.paneKey}
          thread={entry}
          selected={index === 1}
          compactMode={compactMode}
          canJump
          previewSuppressed
          onSelect={() => {}}
          onJump={() => {}}
          onMarkRead={() => {}}
          onMarkUnread={() => {}}
          onClear={() => {}}
        />
      ))}
    </div>
  )
}

export const full = defineFixture({
  width: 320,
  render: () => <ActivityCards />
})

export const narrowCompact = defineFixture({
  width: 240,
  render: () => <ActivityCards compactMode />
})
