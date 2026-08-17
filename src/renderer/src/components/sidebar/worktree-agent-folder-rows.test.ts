import { describe, expect, it } from 'vitest'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import type { Tab } from '../../../../shared/tab-types'
import type { TabFolderGroup } from '../../../../shared/tab-folder-types'
import { buildWorktreeAgentFolderSections } from './worktree-agent-folder-rows'

const WT = 'wt-1'
const GROUP = 'split-1'

function makeTab(id: string, folderGroupId?: string | null): Tab {
  return {
    id,
    entityId: id,
    groupId: GROUP,
    worktreeId: WT,
    contentType: 'terminal',
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...(folderGroupId !== undefined ? { folderGroupId } : {})
  }
}

function makeAgent(tabId: string): DashboardAgentRow {
  return {
    paneKey: `${tabId}:leaf`,
    tab: {
      id: tabId,
      ptyId: null,
      worktreeId: WT,
      title: tabId,
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    },
    agentType: 'codex',
    state: 'idle',
    startedAt: 1,
    entry: {
      paneKey: `${tabId}:leaf`,
      worktreeId: WT,
      agentType: 'codex',
      state: 'done',
      updatedAt: 1,
      stateStartedAt: 1,
      prompt: '',
      stateHistory: []
    }
  }
}

function makeFolder(id: string, tabOrder: string[]): TabFolderGroup {
  return {
    id,
    worktreeId: WT,
    splitGroupId: GROUP,
    name: id,
    color: '#3b82f6',
    collapsed: false,
    tabOrder,
    sortOrder: 0,
    createdAt: 1
  }
}

describe('buildWorktreeAgentFolderSections', () => {
  it('keeps ungrouped agents flat', () => {
    const agents = [makeAgent('tab-1'), makeAgent('tab-2')]
    expect(
      buildWorktreeAgentFolderSections(agents, [], [makeTab('tab-1'), makeTab('tab-2')])
    ).toEqual([
      { type: 'agent', agent: agents[0] },
      { type: 'agent', agent: agents[1] }
    ])
  })

  it('nests agents whose tabs belong to a folder and leaves others flat', () => {
    const agents = [makeAgent('tab-1'), makeAgent('tab-2'), makeAgent('tab-3')]
    const folder = makeFolder('folder-1', ['tab-2', 'tab-1'])
    const sections = buildWorktreeAgentFolderSections(
      agents,
      [folder],
      [makeTab('tab-1', 'folder-1'), makeTab('tab-2', 'folder-1'), makeTab('tab-3')]
    )

    expect(sections).toEqual([
      { type: 'folder', folder, agents: [agents[1], agents[0]] },
      { type: 'agent', agent: agents[2] }
    ])
  })
})
