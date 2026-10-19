import { getDefaultSettings } from '../../../../shared/constants'
import type { Project, ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import type { DetectedWorktree, Worktree } from '../../../../shared/worktree/types'
import { cloneDefaultWorkspaceStatuses } from '../../../../shared/workspace-statuses'
import type { PendingWorktreeCreation } from '@/lib/pending-worktree-creation'
import type { AppState } from '@/store/types'
import {
  GOLDEN_NOW,
  folder,
  group,
  lineage,
  mainWt,
  prEntry,
  repo,
  wt
} from './sidebar-list-golden-factories.test-fixture'

// Hosts: local, an SSH box, and a paired Orca server (runtime environment).
const orca = repo('orca', 'orca', { projectGroupId: 'pg-work' })
const orcaSsh = repo('orca-ssh', 'orca', { connectionId: 'gpu-vm' })
const api = repo('api', 'api', { executionHostId: 'runtime:env-1' })
const lab = repo('lab', 'lab', { projectGroupId: 'pg-nested' })
const shared = repo('shared', 'shared')
const empty = repo('empty', 'empty')
const ext = repo('ext', 'ext', { externalWorktreeVisibility: 'hide', addedAt: GOLDEN_NOW })

const oMain = mainWt(orca, { sortOrder: 10, lastActivityAt: GOLDEN_NOW - 9_000_000 })
const oA = wt(orca, 'feat-a', {
  isPinned: true,
  sortOrder: 50,
  lastActivityAt: GOLDEN_NOW - 1_000,
  linkedPR: 11
})
const oB = wt(orca, 'feat-b', {
  sortOrder: 40,
  workspaceStatus: 'in-review',
  lastActivityAt: GOLDEN_NOW - 5_000
})
const oC = wt(orca, 'feat-c', { sortOrder: 30, isPinned: true, manualOrder: 3 })
const oD = wt(orca, 'Zeta', {
  sortOrder: 20,
  manualOrder: 9,
  createdAt: GOLDEN_NOW - 1_000,
  workspaceStatus: 'completed'
})
const oArchived = wt(orca, 'archived', { isArchived: true, sortOrder: 99 })
const osMain = mainWt(orcaSsh, { sortOrder: 5 })
const osX = wt(orcaSsh, 'remote-x', { isPinned: true, sortOrder: 45, hostId: 'ssh:gpu-vm' })
const aMain = mainWt(api, { sortOrder: 4, hostId: 'runtime:env-1' })
const aY = wt(api, 'api-y', {
  sortOrder: 35,
  hostId: 'runtime:env-1',
  workspaceStatus: 'completed',
  lastActivityAt: GOLDEN_NOW - 2_000
})
const lMain = mainWt(lab, { sortOrder: 3 })
const lMr = wt(lab, 'gitlab-mr', { sortOrder: 25, linkedGitLabMR: 7 })
// The same workspace id published by two hosts.
const sLocal = wt(shared, 'same', { sortOrder: 15, hostId: 'local' })
const sSsh: Worktree = { ...sLocal, hostId: 'ssh:gpu-vm', isPinned: true, sortOrder: 16 }
const eMain = mainWt(ext, { sortOrder: 2 })

export const GOLDEN_WORKTREE_IDS = {
  orcaFeatA: oA.id,
  orcaFeatD: oD.id
}

const detectedHidden: DetectedWorktree = {
  ...wt(ext, 'detected-hidden'),
  ownership: 'external',
  selectedCheckout: false,
  visible: false
}

const pendingCreation: PendingWorktreeCreation = {
  creationId: 'creation-1',
  phase: 'creating',
  status: 'creating',
  startedAt: GOLDEN_NOW,
  indeterminate: true,
  loaderVisible: true,
  request: {
    repoId: 'api',
    name: 'new-api',
    setupDecision: 'inherit',
    agent: null,
    pendingFirstAgentMessageRename: false,
    note: '',
    startupPlan: null,
    quickPrompt: '',
    quickTelemetry: null
  }
}

const projects: Project[] = [
  {
    id: 'p-orca',
    displayName: 'orca',
    badgeColor: '#737373',
    sourceRepoIds: [orca.id, orcaSsh.id],
    createdAt: 1,
    updatedAt: 1
  }
]

function setup(repoValue: Repo, hostId: ProjectHostSetup['hostId']): ProjectHostSetup {
  return {
    id: repoValue.id,
    projectId: 'p-orca',
    hostId,
    repoId: repoValue.id,
    path: repoValue.path,
    displayName: repoValue.displayName,
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1
  }
}

export type GoldenView = Pick<
  AppState,
  'groupBy' | 'sortBy' | 'projectOrderBy' | 'collapsedGroups'
> & {
  pinnedInGroups: boolean
}

/** Store state for one golden capture; scenario overrides land on top. */
export function buildGoldenStoreState(
  view: GoldenView,
  overrides: Partial<AppState> = {}
): Partial<AppState> {
  const worktreesByRepo: AppState['worktreesByRepo'] = {
    [orca.id]: [oMain, oA, oB, oC, oD, oArchived],
    [orcaSsh.id]: [osMain, osX],
    [api.id]: [aMain, aY],
    [lab.id]: [lMain, lMr],
    [shared.id]: [sLocal, sSsh],
    [empty.id]: [],
    [ext.id]: [eMain]
  }
  const settings = {
    ...getDefaultSettings('/home/me'),
    showPinnedWorktreesInGroups: view.pinnedInGroups
  }
  return {
    repos: [orca, orcaSsh, api, lab, shared, empty, ext],
    worktreesByRepo,
    worktreeLineageById: {
      [oB.id]: lineage(oB, oA),
      [oC.id]: lineage(oC, oB),
      // Cross-project lineage: a lab workspace spawned from orca's feat-a.
      [lMr.id]: lineage(lMr, oA)
    },
    projects,
    projectHostSetups: [setup(orca, 'local'), setup(orcaSsh, 'ssh:gpu-vm')],
    projectGroups: [
      group('pg-work', 'Work', { tabOrder: 0 }),
      group('pg-nested', 'Nested', { parentGroupId: 'pg-work', tabOrder: 0 }),
      group('pg-folders', 'Folders', {
        parentPath: '/folders',
        createdFrom: 'folder-scan',
        tabOrder: 1
      }),
      group('pg-remote-folders', 'Remote folders', {
        parentPath: '/home/me/folders',
        createdFrom: 'folder-scan',
        connectionId: 'gpu-vm',
        tabOrder: 2
      })
    ],
    folderWorkspaces: [
      folder('fw-notes', 'pg-folders', { sortOrder: 2 }),
      folder('fw-review', 'pg-folders', { workspaceStatus: 'in-review', manualOrder: 7 }),
      folder('fw-remote', 'pg-remote-folders', { connectionId: 'gpu-vm', sortOrder: 1 })
    ],
    prCache: {
      [`${orca.id}::feat-a`]: prEntry(11, 'open'),
      [`${orca.id}::feat-b`]: prEntry(12, 'merged'),
      [`${orca.id}::Zeta`]: prEntry(13, 'closed'),
      [`ssh:gpu-vm::${orcaSsh.id}::remote-x`]: prEntry(21, 'draft'),
      [`runtime:env-1::${api.id}::api-y`]: prEntry(31, 'open')
    },
    detectedWorktreesByRepo: {
      [ext.id]: {
        repoId: ext.id,
        authoritative: true,
        source: 'git',
        worktrees: [detectedHidden]
      }
    },
    pendingWorktreeCreations: { [pendingCreation.creationId]: pendingCreation },
    sshTargetLabels: new Map([['gpu-vm', 'GPU VM']]),
    workspaceStatuses: cloneDefaultWorkspaceStatuses(),
    settings,
    showSleepingWorkspaces: true,
    filterRepoIds: [],
    visibleWorkspaceHostIds: null,
    workspaceHostScope: 'all',
    groupBy: view.groupBy,
    sortBy: view.sortBy,
    projectOrderBy: view.projectOrderBy,
    collapsedGroups: view.collapsedGroups,
    ...overrides
  }
}

/** A live terminal in feat-a, so "hide sleeping" keeps exactly that workspace awake. */
export function goldenLiveTerminalState(): Partial<AppState> {
  return {
    tabsByWorktree: {
      [oA.id]: [
        {
          id: 'tab-live',
          ptyId: 'pty-live',
          worktreeId: oA.id,
          title: 'Terminal 1',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: GOLDEN_NOW
        }
      ]
    },
    ptyIdsByTabId: { 'tab-live': ['pty-live'] }
  }
}

/** ext after its first import prompt: the detected worktree shows as an inbox row, not a card. */
export function goldenInboxState(): Partial<AppState> {
  return {
    repos: [
      orca,
      orcaSsh,
      api,
      lab,
      shared,
      empty,
      { ...ext, externalWorktreeVisibilityPromptDismissedAt: GOLDEN_NOW }
    ]
  }
}
