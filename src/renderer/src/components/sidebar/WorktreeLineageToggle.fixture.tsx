import { useState } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { Tab } from '../../../../shared/tab-types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { structuredAgentSessionPaneKey } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import WorktreeCard from './WorktreeCard'

const repo: Repo = {
  id: 'lineage-preview',
  path: '/preview/orca',
  displayName: 'orca',
  badgeColor: '',
  addedAt: 1
}
function worktree(id: string, displayName: string): Worktree {
  return {
    id,
    displayName,
    repoId: repo.id,
    path: `/preview/orca/${id}`,
    branch: id,
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1
  }
}
const parent = worktree('release', 'Prepare the release')
const children = [
  worktree('checks', 'Run release checks'),
  worktree('review', 'Review compatibility'),
  worktree('docs', 'Update release notes'),
  worktree('idle', 'Follow-up tasks')
]
const tabs: Tab[] = children.slice(0, 3).map((child, index) => ({
  id: `chat-${child.id}`,
  entityId: `11111111-1111-4111-8111-11111111111${index}`,
  contentType: 'agent-session',
  agentSessionAgent: 'codex',
  worktreeId: child.id,
  groupId: 'preview',
  executionHostId: 'local',
  label: 'Chat',
  customLabel: null,
  color: null,
  sortOrder: index,
  createdAt: Date.now()
}))
const entries: AgentStatusEntry[] = tabs.map((tab, index) => ({
  paneKey: structuredAgentSessionPaneKey(tab.id, tab.entityId),
  worktreeId: tab.worktreeId,
  agentType: 'codex',
  prompt: '',
  state: index === 0 ? 'working' : index === 1 ? 'waiting' : 'done',
  updatedAt: Date.now(),
  stateStartedAt: Date.now(),
  stateHistory: []
}))
function Preview({
  expanded = false,
  childWorktrees = children
}: {
  expanded?: boolean
  childWorktrees?: Worktree[]
}) {
  const [collapsed, setCollapsed] = useState(!expanded)
  return (
    <div className="bg-worktree-sidebar p-2 text-worktree-sidebar-foreground">
      <WorktreeCard
        worktree={parent}
        repo={repo}
        isActive={false}
        nativeDragEnabled={false}
        lineageChildWorktreeIds={childWorktrees.map((child) => child.id)}
        lineageChildCount={childWorktrees.length}
        lineageCollapsed={collapsed}
        onLineageToggle={(event) => {
          event.stopPropagation()
          setCollapsed(!collapsed)
        }}
        lineageChildren={
          collapsed
            ? undefined
            : childWorktrees.map((child) => (
                <WorktreeCard
                  key={child.id}
                  worktree={child}
                  repo={repo}
                  isActive={false}
                  nativeDragEnabled={false}
                  hideRepoBadge
                />
              ))
        }
      />
    </div>
  )
}
const store = {
  repos: [repo],
  worktreesByRepo: { [repo.id]: [parent, ...children] },
  unifiedTabsByWorktree: Object.fromEntries(tabs.map((tab) => [tab.worktreeId, [tab]])),
  agentStatusByPaneKey: Object.fromEntries(entries.map((entry) => [entry.paneKey, entry])),
  agentStatusEpoch: 1,
  agentActivityDisplayMode: 'compact' as const
}
export const collapsed = defineFixture({ width: 288, store, render: () => <Preview /> })
export const expanded = defineFixture({ width: 288, store, render: () => <Preview expanded /> })
export const narrow = defineFixture({ width: 180, store, render: () => <Preview /> })
export const newCards = defineFixture({
  width: 288,
  store: {
    ...store,
    agentStatusEpoch: 4
  },
  setup: () => {
    useAppStore.setState(({ settings }) => ({
      settings: settings && { ...settings, experimentalNewWorktreeCardStyle: true }
    }))
  },
  render: () => <Preview expanded />
})

const manyChildren = Array.from({ length: 120 }, (_, index) => worktree(`child-${index}`, 'Task'))
const manyTabs = manyChildren.slice(0, 90).map((child, index) => ({
  ...tabs[index % tabs.length],
  id: `chat-${child.id}`,
  entityId: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
  worktreeId: child.id
}))
export const manyNarrow = defineFixture({
  width: 180,
  store: {
    ...store,
    agentStatusEpoch: 2,
    worktreesByRepo: { [repo.id]: [parent, ...manyChildren] },
    unifiedTabsByWorktree: Object.fromEntries(manyTabs.map((tab) => [tab.worktreeId, [tab]])),
    agentStatusByPaneKey: Object.fromEntries(
      manyTabs.map((tab, index) => {
        const paneKey = structuredAgentSessionPaneKey(tab.id, tab.entityId)
        return [
          paneKey,
          { ...entries[index % entries.length], paneKey, worktreeId: tab.worktreeId }
        ]
      })
    )
  },
  render: () => <Preview childWorktrees={manyChildren} />
})
export const inactive = defineFixture({
  width: 288,
  store: { ...store, agentStatusEpoch: 3, unifiedTabsByWorktree: {}, agentStatusByPaneKey: {} },
  render: () => <Preview />
})
