import { defineFixture } from '../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../shared/orca-profiles/constants'
import type { SidebarView } from '../../../../shared/ui-chrome/sidebar-body'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { stubBots } from '../../component-fixtures/fixture-bots'
import { ConfirmationDialogProvider } from '../dismiss/confirmation/confirmation-dialog'
import Sidebar from './index'
import {
  conversationRepos,
  conversationSessions,
  conversationStore,
  conversationWorktrees
} from './ProjectConversationList.test-fixture'

const acmeBranches = ['fix/login-redirect', 'feature/csv-export'].map((branch, index) =>
  makeWorktree({
    id: `acme::/projects/acme-${index}`,
    repoId: 'acme',
    path: `/projects/acme-${index}`,
    branch: `refs/heads/${branch}`,
    displayName: branch.split('/')[1]!,
    lastActivityAt: Date.now() - (index + 1) * 3_600_000
  })
)

function sidebarView(view: SidebarView) {
  return defineFixture({
    width: 300,
    store: {
      ...conversationStore,
      repos: conversationRepos,
      worktreesByRepo: {
        acme: [conversationWorktrees[0]!, ...acmeBranches],
        example: [conversationWorktrees[1]!]
      },
      settings: { ...getDefaultSettings('/home/fixture'), uiLanguage: 'en' },
      sidebarOpen: true,
      startupWorktreeRefreshCompleted: true,
      sidebarView: view,
      sidebarBody: view
    },
    setup: () => {
      stubBots([])
      window.api.aiVault.listSessions = async () => ({
        sessions: conversationSessions,
        issues: [],
        scannedAt: '2026-10-26T00:00:00Z'
      })
      window.api.aiVault.cancelListSessions = async () => {}
    },
    interact: async (frame) => {
      for (
        let i = 0;
        i < 60 && !frame.querySelector('[data-conversation-id], [data-worktree-id]');
        i++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    },
    render: () => (
      <ConfirmationDialogProvider>
        <div className="flex" style={{ height: 720 }}>
          <Sidebar
            worktreeScrollOffsetRef={{ current: 0 }}
            worktreeScrollAnchorRef={{ current: null }}
          />
        </div>
      </ConfirmationDialogProvider>
    )
  })
}

export const projects = sidebarView('workspaces')
export const sessions = sidebarView('conversations')
