// The Projects list grouped by project, on invented data: the Tree card style next to the
// Experimental one it builds on, and Recent order mixing a folder group with ungrouped projects.
import { useRef } from 'react'
import { useAppStore } from '@/store'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { stubBots } from '../../../../component-fixtures/fixture-bots'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import type { VirtualizedScrollAnchor } from '@/lib/list-interaction/virtualized-scrolling/useVirtualizedScrollAnchor'
import { setRendererUiLanguage } from '@/i18n/i18n'
import type { SupportedUiLocale } from '../../../../../../shared/i18n/ui-locale'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import { folderWorkspaceKey } from '../../../../../../shared/workspace/identity/workspace-scope'
import { ConfirmationDialogProvider } from '../../../dismiss/confirmation/confirmation-dialog'
import { SidebarContentViewport } from '../../SidebarContentViewport'
import SidebarHeader from '../../chrome/SidebarHeader'
import { SidebarProjectsListSlot } from '../../SidebarBotsSplit'
import { MINUTE, seedWorkspaces, type WorkspaceSeed } from '../../worktree-card-slot-fixture-seeds'
import WorktreeList from './WorktreeList'

const now = Date.now()

const GROUP: ProjectGroup = {
  id: 'acme-platform',
  name: 'acme-platform',
  parentPath: '/work/acme-platform',
  parentGroupId: null,
  createdFrom: 'folder-scan',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 0,
  updatedAt: 0
}

function repo(id: string, path: string, badgeColor: string, grouped = false): Repo {
  return {
    id,
    path,
    displayName: path.split('/').at(-1)!,
    badgeColor,
    addedAt: 0,
    ...(grouped ? { projectGroupId: GROUP.id } : {})
  }
}

const REPOS = [
  repo('storefront', '/work/storefront', '#2563eb'),
  repo('payments-api', '/work/acme-platform/payments-api', '#16a34a', true),
  repo('design-system', '/work/acme-platform/design-system', '#db2777', true),
  repo('docs-site', '/work/docs-site', '#ca8a04')
]

function checkout(repoId: string, name: string | null, minutesAgo: number): Worktree {
  const owner = REPOS.find((candidate) => candidate.id === repoId)!
  const path = name ? `${owner.path}-worktrees/${name}` : owner.path
  return {
    id: `${repoId}::${path}`,
    repoId,
    path,
    displayName: name ?? owner.displayName,
    branch: name ? `feature/${name}` : 'main',
    head: 'abc123',
    isBare: false,
    isMainWorktree: name === null,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: now - minutesAgo * MINUTE,
    hostId: 'local'
  }
}

const STOREFRONT_MAIN = checkout('storefront', null, 1)
const PAYMENTS_MAIN = checkout('payments-api', null, 40)
const WORKTREES: Record<string, Worktree[]> = {
  storefront: [
    STOREFRONT_MAIN,
    checkout('storefront', 'fix-promo-codes', 3),
    checkout('storefront', 'upgrade-react-19', 95)
  ],
  'payments-api': [PAYMENTS_MAIN, checkout('payments-api', 'refund-idempotency', 25)],
  'design-system': [
    checkout('design-system', null, 300),
    checkout('design-system', 'dark-mode-tokens', 180)
  ],
  'docs-site': [checkout('docs-site', null, 2 * 24 * 60), checkout('docs-site', 'api-guides', 3000)]
}

const SESSIONS = [
  makeFolderWorkspace({
    id: 'plan-q3',
    projectGroupId: GROUP.id,
    name: 'acme-platform workspace',
    folderPath: GROUP.parentPath!,
    lastActivityAt: now - 12 * MINUTE
  }),
  makeFolderWorkspace({
    id: 'deps-audit',
    projectGroupId: GROUP.id,
    name: 'acme-platform workspace',
    folderPath: GROUP.parentPath!,
    lastActivityAt: now - 70 * MINUTE
  })
]

// Chats: agents in a project's main checkout or in a group session; one more in a worktree.
const CHATS: WorkspaceSeed[] = [
  {
    id: STOREFRONT_MAIN.id,
    tabPrefix: 'storefront',
    name: 'storefront',
    agents: [
      {
        agentType: 'claude',
        state: 'working',
        minutesAgo: 1,
        prompt: 'Debug double charge'
      },
      { agentType: 'codex', state: 'done', minutesAgo: 25, prompt: 'Review cart refactor' }
    ]
  },
  {
    id: PAYMENTS_MAIN.id,
    tabPrefix: 'payments',
    name: 'payments-api',
    agents: [
      {
        agentType: 'claude',
        state: 'done',
        minutesAgo: 40,
        prompt: 'Explain webhook retries'
      }
    ]
  },
  {
    id: WORKTREES.storefront[1]!.id,
    tabPrefix: 'promo',
    name: 'fix-promo-codes',
    agents: [{ agentType: 'claude', state: 'working', minutesAgo: 3, prompt: 'Fix promo codes' }]
  },
  {
    id: folderWorkspaceKey('plan-q3'),
    tabPrefix: 'plan-q3',
    name: 'plan-q3',
    agents: [{ agentType: 'claude', state: 'done', minutesAgo: 12, prompt: 'Plan Q3 migration' }]
  },
  {
    id: folderWorkspaceKey('deps-audit'),
    tabPrefix: 'deps-audit',
    name: 'deps-audit',
    agents: [{ agentType: 'codex', state: 'done', minutesAgo: 70, prompt: 'Audit dependencies' }]
  }
]

function seed(tree: boolean): void {
  seedWorkspaces(CHATS, now)
  useAppStore.setState((state) => ({
    repos: REPOS,
    worktreesByRepo: WORKTREES,
    projectGroups: [GROUP],
    folderWorkspaces: SESSIONS,
    groupBy: 'repo',
    projectOrderBy: 'recent',
    hideDefaultBranchWorkspace: true,
    collapsedGroups: new Set(['project:repo:docs-site']),
    activeWorktreeId: STOREFRONT_MAIN.id,
    activeWorkspaceExecutionHostId: 'local',
    // The invented folders exist nowhere; report them present so rows don't show "folder missing".
    getFreshFolderWorkspacePathStatus: () => ({ path: GROUP.parentPath!, exists: true }),
    settings: state.settings
      ? { ...state.settings, experimentalNewWorktreeCardStyle: true, experimentalProjectTree: tree }
      : state.settings
  }))
}

function ProjectWorkspaces(): React.JSX.Element {
  const scrollOffsetRef = useRef(0)
  const scrollAnchorRef = useRef<VirtualizedScrollAnchor>(null)
  return <WorktreeList scrollOffsetRef={scrollOffsetRef} scrollAnchorRef={scrollAnchorRef} />
}

function Sidebar(): React.JSX.Element {
  return (
    <ConfirmationDialogProvider>
      <div
        className="flex flex-col overflow-hidden bg-worktree-sidebar text-worktree-sidebar-foreground"
        style={{ height: 790 }}
      >
        <SidebarContentViewport>
          <SidebarHeader collapsible onWorkspaceBoardMenuOpenChange={() => {}} />
          <SidebarProjectsListSlot botsShown={false}>
            <ProjectWorkspaces />
          </SidebarProjectsListSlot>
        </SidebarContentViewport>
      </div>
    </ConfirmationDialogProvider>
  )
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 80))

function sidebar(tree: boolean, locale: SupportedUiLocale = 'en') {
  return {
    width: 300,
    setup: async () => {
      stubBots([])
      await setRendererUiLanguage(locale)
      seed(tree)
    },
    render: () => <Sidebar />,
    interact: settle
  }
}

/** Tree: project cards with their Chats and Worktrees, a folder group's chats on its panel. */
export const tree = defineFixture(sidebar(true))

/** The same projects in the Experimental card style, which Tree builds on. */
export const experimental = defineFixture(sidebar(false))

export const treeGerman = defineFixture(sidebar(true, 'de'))
export const treeJapanese = defineFixture(sidebar(true, 'ja'))
