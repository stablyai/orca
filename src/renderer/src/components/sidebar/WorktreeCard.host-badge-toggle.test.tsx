import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeCardProperty } from '../../../../shared/ui-chrome-types'
import { buildRows } from './worktree-list/grouping/build-rows.test-fixture'
import { PINNED_GROUP_KEY } from '../../../../shared/sidebar-list/group-keys'
import type { WorktreeCardProps } from './worktree-card-model'
import type { Worktree } from '../../../../shared/worktree/types'

const fetchHostedReviewForBranch = vi.fn()
const fetchIssue = vi.fn()
const fetchLinearIssue = vi.fn()
const openModal = vi.fn()
const updateWorktreeMeta = vi.fn()

const HOST_LABEL = 'gpu-vm'
let worktreeCardProperties: WorktreeCardProperty[] = []
let settings: Partial<GlobalSettings> | null = null
const WORKTREE_CARD_IMPORT_TIMEOUT_MS = 15_000

vi.mock('@/store', () => {
  const getState = () => ({
    deleteStateByWorktreeId: {},
    fetchHostedReviewForBranch,
    fetchIssue,
    fetchLinearIssue,
    gitConflictOperationByWorktree: {},
    hostedReviewCache: {},
    issueCache: {},
    linearIssueCache: {},
    openModal,
    projectGroups: [],
    remoteBranchConflictByWorktreeId: {},
    settings,
    sshConnectionStates: new Map(),
    sshTargetLabels: new Map(),
    updateWorktreeMeta,
    workspacePortScan: null,
    worktreeCardProperties
  })
  return {
    useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector(getState()), {
      getState,
      subscribe: () => () => {}
    })
  }
})

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('./use-worktree-activity-status', () => ({
  useWorktreeActivityStatus: () => 'idle'
}))

vi.mock('./use-worktree-sleep-state', () => ({
  useIsSleepingWorktree: () => false
}))

vi.mock('./CacheTimer', () => ({
  default: () => null,
  usePromptCacheCountdownStartedAt: () => null
}))

vi.mock('./WorktreeCardAgents', () => ({
  default: () => null
}))

vi.mock('./WorktreeContextMenu', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
  WORKTREE_NATIVE_CONTEXT_MENU_ATTR: 'data-worktree-native-context-menu',
  WORKTREE_CONTEXT_MENU_SCOPE_ATTR: 'data-orca-context-menu-scope'
}))

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'orca',
    badgeColor: '#999999',
    repoIcon: { type: 'emoji', emoji: '🦊' },
    addedAt: 1,
    ...overrides
  }
}

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo-1::/repo/worktrees/host',
    repoId: 'repo-1',
    path: '/repo/worktrees/host',
    displayName: 'Host tree',
    branch: 'feature/host',
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
    lastActivityAt: 1,
    ...overrides
  }
}

// Imported per test so the mocked store is seeded before the module reads it.
async function renderCardMarkup(props: Partial<WorktreeCardProps> = {}): Promise<string> {
  const { default: WorktreeCard } = await import('./WorktreeCard')
  return renderToStaticMarkup(
    <WorktreeCard
      worktree={makeWorktree()}
      repo={makeRepo()}
      isActive={false}
      hostContextLabel={HOST_LABEL}
      {...props}
    />
  )
}

describe('WorktreeCard host badge toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    worktreeCardProperties = []
    settings = { compactWorktreeCards: false, experimentalNewWorktreeCardStyle: false }
  })

  it(
    'shows the execution-host label when the host card property is enabled',
    async () => {
      worktreeCardProperties = ['host']

      expect(await renderCardMarkup()).toContain(HOST_LABEL)
    },
    WORKTREE_CARD_IMPORT_TIMEOUT_MS
  )

  it(
    'hides the execution-host label when the host card property is off',
    async () => {
      worktreeCardProperties = ['status']

      expect(await renderCardMarkup()).not.toContain(HOST_LABEL)
    },
    WORKTREE_CARD_IMPORT_TIMEOUT_MS
  )

  it.each(['detailed', 'compact', 'new'])(
    'renders planned owner text once in %s cards',
    async (style) => {
      settings = {
        compactWorktreeCards: style === 'compact',
        experimentalNewWorktreeCardStyle: style === 'new'
      }
      const owner = makeRepo({ displayName: 'Backend checkout' })
      const parentRepo = makeRepo({ id: 'parent-repo', displayName: 'Frontend checkout' })
      const parent = makeWorktree({
        id: 'parent',
        repoId: parentRepo.id,
        instanceId: 'parent-instance'
      })
      const child = makeWorktree({ instanceId: 'child-instance' })
      const graph = {
        [child.id]: {
          worktreeId: child.id,
          worktreeInstanceId: 'child-instance',
          parentWorktreeId: parent.id,
          parentWorktreeInstanceId: 'parent-instance',
          origin: 'cli' as const,
          capture: { source: 'explicit-cli-flag' as const, confidence: 'explicit' as const },
          createdAt: 1
        }
      }
      for (const mode of ['repo', 'none', 'workspace-status', 'pr-status'] as const) {
        for (const pinned of [false, true]) {
          const trees = [{ ...parent, isPinned: pinned }, child]
          const rows = buildRows(
            mode,
            trees,
            new Map([
              [owner.id, owner],
              [parentRepo.id, parentRepo]
            ]),
            null,
            new Set(),
            undefined,
            undefined,
            undefined,
            graph,
            new Map(trees.map((row) => [row.id, row])),
            true
          )
          for (const row of rows) {
            if (row.type !== 'item') {
              continue
            }
            const rowRepo = row.repo ?? owner
            const markup = await renderCardMarkup({
              worktree: row.worktree,
              repo: rowRepo,
              hideRepoBadge: mode === 'repo' && !row.showProjectName,
              showProjectName: row.showProjectName,
              inPinnedSection: row.sectionKey === PINNED_GROUP_KEY
            })
            const shouldShowProject = mode !== 'repo' || pinned || row.worktree.id !== parent.id
            expect(markup.includes(rowRepo.displayName)).toBe(shouldShowProject)
            expect(markup).not.toContain(HOST_LABEL)
          }
        }
      }
    },
    WORKTREE_CARD_IMPORT_TIMEOUT_MS
  )
})
