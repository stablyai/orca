import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { reconcileHydratedWorkspaceTabModels } from '../../app-shell/reconcile-hydrated-workspace-tab-models'
import {
  LAYOUT_OWNER_WRITTEN_SESSION_GOLDEN_PATH,
  LAYOUT_OWNER_WRITTEN_SESSION_WORKTREE_ID as WT
} from '../../../../shared/__fixtures__/layout-owner-written-session-golden-paths'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { collectLayoutLeafIdsInOrder } from '../../../../shared/workspace-layout/terminal-pane-tree'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { createTestStore, makeWorktree } from './store-test-helpers'
import { createStoreSessionMockApi } from './store-session-test-harness'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createStoreSessionMockApi()

/** The startup hydration a switch-off window runs (use-app-startup-hydration.ts). */
function restoredWindow(session: WorkspaceSessionState) {
  const store = createTestStore()
  store.setState({
    repos: [
      {
        id: 'repo-local',
        path: '/fixture/local',
        displayName: 'local',
        badgeColor: '#000',
        addedAt: 0
      }
    ],
    worktreesByRepo: {
      'repo-local': [makeWorktree({ id: WT, repoId: 'repo-local', path: '/fixture/local' })]
    }
  })
  const actions = store.getState()
  actions.hydrateWorkspaceSession(session, {})
  actions.hydrateTabsSession(session, {})
  actions.hydrateEditorSession(session, {})
  actions.hydrateBrowserSession(session, {})
  reconcileHydratedWorkspaceTabModels(session, store.getState().reconcileWorktreeTabModels)
  return store.getState()
}

const leaf = (n: number): string => `${n}${n}${n}${n}${n}${n}${n}${n}-1111-4111-8111-111111111111`

describe.skipIf(ORCA_LAYOUT_OWNER_IS_MAIN)(
  'a switch-off window restoring the session a layout-owner build wrote (downgrade probe, L8)',
  () => {
    it('shows the same tabs, panes, groups, editor file and browser tab', () => {
      const golden: WorkspaceSessionState = JSON.parse(
        readFileSync(LAYOUT_OWNER_WRITTEN_SESSION_GOLDEN_PATH, 'utf8')
      )

      const state = restoredWindow(golden)

      expect(
        state.tabsByWorktree[WT]?.map((tab) => [tab.id, tab.customTitle ?? tab.title])
      ).toEqual([
        ['tab-shell', 'Terminal 1'],
        ['tab-build', 'Build']
      ])
      const panes = (tabId: string) => {
        const layout = state.terminalLayoutsByTabId[tabId]
        return {
          leaves: collectLayoutLeafIdsInOrder(layout?.root),
          active: layout?.activeLeafId,
          bindings: layout?.ptyIdsByLeafId
        }
      }
      expect(state.terminalLayoutsByTabId['tab-shell']?.root).toMatchObject({
        type: 'split',
        direction: 'vertical'
      })
      // The pane binding must survive the downgrade, or the shell would not reattach.
      expect(panes('tab-shell')).toEqual({
        leaves: [leaf(1), leaf(3)],
        active: leaf(1),
        bindings: { [leaf(1)]: 'pty-shell' }
      })
      expect(panes('tab-build')).toEqual({ leaves: [leaf(2)], active: leaf(2), bindings: {} })
      const groups = state.groupsByWorktree[WT] ?? []
      expect(groups.map((group) => [group.tabOrder, group.activeTabId])).toEqual([
        [['tab-shell', 'tab-readme', 'tab-docs'], 'tab-shell'],
        [['tab-build'], 'tab-build']
      ])
      expect(state.layoutByWorktree[WT]).toMatchObject({ type: 'split', direction: 'horizontal' })
      const byId = new Map(state.unifiedTabsByWorktree[WT]?.map((tab) => [tab.id, tab]))
      expect(
        groups.map((group) =>
          group.tabOrder.map((id) => [byId.get(id)?.contentType, byId.get(id)?.groupId])
        )
      ).toEqual([
        [
          ['terminal', groups[0]?.id],
          ['editor', groups[0]?.id],
          ['browser', groups[0]?.id]
        ],
        [['terminal', groups[1]?.id]]
      ])
      expect(byId.size).toBe(4)
      expect(
        state.unifiedTabsByWorktree[WT]?.find((tab) => tab.id === 'tab-build')?.customLabel
      ).toBe('Build')
      expect(state.openFiles.map((file) => [file.filePath, file.mode])).toEqual([
        ['/fixture/local/README.md', 'edit']
      ])
      expect(state.browserTabsByWorktree[WT]?.map((tab) => [tab.id, tab.pageIds])).toEqual([
        ['browser-docs', ['page-docs']]
      ])
      expect(state.browserPagesByWorkspace['browser-docs']?.map((page) => page.url)).toEqual([
        'https://example.com/docs'
      ])
      expect([state.activeWorktreeId, state.activeTabId]).toEqual([WT, 'tab-shell'])
      // The closed tab stays closed.
      expect(JSON.stringify(state.unifiedTabsByWorktree)).not.toContain('tab-scratch')
      expect(state.tabsByWorktree[WT]?.some((tab) => tab.id === 'tab-scratch')).toBe(false)
    })
  }
)
