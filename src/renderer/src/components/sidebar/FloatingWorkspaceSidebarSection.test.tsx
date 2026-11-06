import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'

const mocks = vi.hoisted(() => ({
  agents: [] as DashboardAgentRow[],
  livePtyIdsByTabId: {} as Record<string, string[]>,
  collapsedGroups: new Set<string>(),
  toggleCollapsedGroup: vi.fn(),
  floatingCwd: '/home/aleksei',
  floatingPanelVisible: false
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, d?: string) => d ?? _k })
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        collapsedGroups: mocks.collapsedGroups,
        toggleCollapsedGroup: mocks.toggleCollapsedGroup,
        settings: {
          floatingTerminalEnabled: true,
          floatingTerminalCwd: mocks.floatingCwd
        },
        floatingWorkspacePanelOpen: mocks.floatingPanelVisible
      }),
    {
      getState: () => ({
        settings: {
          floatingTerminalEnabled: true,
          floatingTerminalCwd: mocks.floatingCwd
        },
        floatingWorkspacePanelOpen: mocks.floatingPanelVisible
      })
    }
  )
}))

vi.mock('@/store/floating-workspace-panel-selector', () => ({
  selectFloatingWorkspacePanelVisible: () => mocks.floatingPanelVisible
}))

vi.mock('./workspace-card/activity/useWorktreeAgentRows', () => ({
  useWorktreeAgentRows: () => mocks.agents
}))

vi.mock('./workspace-card/activity/worktree-card-status-inputs', () => ({
  selectLivePtyIdsForWorktree: () => mocks.livePtyIdsByTabId
}))

vi.mock('./workspace-card/activity/use-worktree-activity-status', () => ({
  useWorktreeActivityStatus: () => 'working'
}))

vi.mock('./workspace-card/surface/StatusIndicator', () => ({
  default: ({ status }: { status: string }) => <span data-status={status} />
}))

vi.mock('./workspace-card/activity/WorktreeCardAgents', () => ({
  default: ({ worktreeId, agents }: { worktreeId: string; agents?: DashboardAgentRow[] }) => (
    <div data-testid="mock-worktree-card-agents" data-worktree-id={worktreeId}>
      {agents?.length ?? 0}
    </div>
  )
}))

import FloatingWorkspaceSidebarSection, {
  FLOATING_SIDEBAR_GROUP_KEY
} from './FloatingWorkspaceSidebarSection'

describe('FloatingWorkspaceSidebarSection', () => {
  beforeEach(() => {
    mocks.agents = []
    mocks.livePtyIdsByTabId = {}
    mocks.collapsedGroups = new Set()
    mocks.floatingCwd = '/home/aleksei'
    mocks.floatingPanelVisible = false
  })

  it('renders nothing when no floating agents or live terminals exist', () => {
    const html = renderToStaticMarkup(<FloatingWorkspaceSidebarSection />)
    expect(html).toBe('')
  })

  it('renders the Floating category header and workspace card when floating agents are active', () => {
    mocks.agents = [
      {
        paneKey: 'tab-float:pane-1',
        tabId: 'tab-float',
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        worktreeName: 'Floating workspace',
        branch: '',
        repoId: FLOATING_TERMINAL_WORKTREE_ID,
        repoName: 'Floating',
        state: 'working',
        stateStartedAt: 1_000,
        startedAt: 1_000,
        label: 'Antigravity',
        isMainWorktree: false
      } as unknown as DashboardAgentRow
    ]
    mocks.livePtyIdsByTabId = { 'tab-float': ['pty-1'] }

    const html = renderToStaticMarkup(<FloatingWorkspaceSidebarSection />)
    expect(html).toContain('data-testid="floating-workspace-sidebar-section"')
    expect(html).toContain('>Floating<')
    expect(html).toContain('>Floating workspace<')
    expect(html).toContain('/home/aleksei')
    expect(html).toContain(`data-worktree-id="${FLOATING_TERMINAL_WORKTREE_ID}"`)
  })

  it('hides the card body while keeping the Floating header when collapsed', () => {
    mocks.livePtyIdsByTabId = { 'tab-float': ['pty-1'] }
    mocks.collapsedGroups = new Set([FLOATING_SIDEBAR_GROUP_KEY])

    const html = renderToStaticMarkup(<FloatingWorkspaceSidebarSection />)
    expect(html).toContain('data-testid="floating-workspace-sidebar-header"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('data-testid="floating-workspace-sidebar-card"')
  })
})
