import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../../../shared/constants'
import type { TerminalLayoutSnapshot } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import { useAppStore } from '@/store'
import {
  makeRepo,
  makeWorktree,
  makeTerminalTab,
  makeUnifiedTab,
  makeGroup,
  makeAgentEntry,
  LEAF_ID
} from '../../../worktree-jump/worktree-jump-palette-test-fixtures'
import WorktreeCard from './WorktreeCard'
import SidebarWorkspaceOptionsMenu from '../../worktree-list/controls/SidebarWorkspaceOptionsMenu'
import { clearWorktreeAgentExpansionStateForTests } from '../activity/worktree-card-agents-expansion-state'

const repo = { ...makeRepo(), displayName: 'Orca' }
const workspace = makeWorktree('compact-header-preview', 'main', {
  repoId: repo.id,
  branch: 'refs/heads/main',
  isMainWorktree: true,
  hostId: 'local'
})
const titles = [
  'Use Orca Image Editor Plugin',
  'Launch OpenInvoiceMock App',
  'Add Security Cameras to Cube Faces',
  'Identify Disk Space Usage',
  'Fix Omarchy Apps Stuck at Screen Top',
  'Clone materia into Projects',
  'Publish Orca Inline Image Markup Plugin',
  'Mount Windows Drive Read/Write'
]
const now = Date.now()
const tabs = titles.map((title, index) => ({
  ...makeTerminalTab(`preview-${index}`, workspace.id, title),
  customTitle: title,
  sortOrder: index
}))
const unified = tabs.map((tab) => ({
  ...makeUnifiedTab(tab.id, workspace.id, tab.id, tab.title),
  executionHostId: 'local' as const
}))
const entries = tabs.map((tab, index) =>
  makeAgentEntry(
    tab.id,
    index === 3 || index === 6 ? 'working' : 'done',
    now - (index + 1) * 60_000,
    {
      worktreeId: workspace.id,
      tabId: tab.id,
      agentType: 'codex',
      prompt: titles[index],
      ...(index === 6 ? { workingMode: 'monitoring' as const } : {})
    }
  )
)
const layout: TerminalLayoutSnapshot = {
  root: { type: 'leaf', leafId: LEAF_ID },
  activeLeafId: LEAF_ID,
  expandedLeafId: null
}

function fixture(
  compact: boolean,
  expanded = false,
  identity: { title: string; branch: string; width: number; folderPath?: string; head?: string } = {
    title: 'main',
    branch: 'main',
    width: 360
  }
) {
  const previewRepo = identity.folderPath ? { ...repo, kind: 'folder' as const } : repo
  const previewWorkspace = {
    ...workspace,
    displayName: identity.title,
    branch: identity.branch ? `refs/heads/${identity.branch}` : '',
    path: identity.folderPath ?? workspace.path,
    head: identity.head ?? workspace.head
  }
  return defineFixture({
    width: identity.width,
    store: {
      settings: { ...getDefaultSettings('/home/fixture'), compactWorktreeHeader: compact },
      repos: [previewRepo],
      worktreesByRepo: { [repo.id]: [previewWorkspace] },
      activeWorktreeId: workspace.id,
      activeWorkspaceExecutionHostId: 'local',
      activeTabId: tabs[6].id,
      activeTabType: 'terminal',
      tabsByWorktree: { [workspace.id]: tabs },
      unifiedTabsByWorktree: { [workspace.id]: unified },
      groupsByWorktree: {
        [workspace.id]: [
          {
            ...makeGroup(
              workspace.id,
              tabs.map((tab) => tab.id)
            ),
            activeTabId: tabs[6].id
          }
        ]
      },
      activeGroupIdByWorktree: { [workspace.id]: `group-${workspace.id}` },
      terminalLayoutsByTabId: Object.fromEntries(tabs.map((tab) => [tab.id, layout])),
      agentStatusByPaneKey: Object.fromEntries(entries.map((entry) => [entry.paneKey, entry])),
      agentActivityDisplayMode: 'compact'
    },
    setup: () => {
      clearWorktreeAgentExpansionStateForTests()
      window.api.settings.set = async (updates) => ({
        ...getDefaultSettings('/home/fixture'),
        ...useAppStore.getState().settings,
        ...updates
      })
      window.api.ui.set = async () => {}
    },
    render: () => (
      <div className="bg-worktree-sidebar p-2 text-worktree-sidebar-foreground">
        <div className="mb-2 flex items-center justify-between px-1 text-[13px] font-medium">
          <span>Projects</span>
          <SidebarWorkspaceOptionsMenu />
        </div>
        <WorktreeCard
          worktree={previewWorkspace}
          repo={previewRepo}
          isActive
          nativeDragEnabled={false}
        />
      </div>
    ),
    interact: expanded
      ? (frame) => {
          frame
            .querySelector<HTMLButtonElement>(
              '[data-compact-workspace-header] button[aria-expanded="false"], .compact-agent-summary-button[aria-expanded="false"]'
            )
            ?.click()
        }
      : undefined
  })
}

export const compact = fixture(true)
export const expanded = fixture(true, true)
export const detailed = fixture(false, true)

export const named = fixture(true, true, {
  title: 'Image editor',
  branch: 'feature/image-comments',
  width: 420
})
export const narrow = fixture(true, true, {
  title: 'Image editor',
  branch: 'feature/image-comments',
  width: 260
})

export const folder = fixture(true, true, {
  title: 'Assets',
  branch: '',
  width: 360,
  folderPath: '/home/fixture/projects/assets'
})
export const detached = fixture(true, true, {
  title: 'Inspect commit',
  branch: '',
  width: 360,
  head: 'abc1234567890abcdef1234567890abcdef12345678'
})
