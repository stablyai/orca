import { useRef, useState } from 'react'
import { vi } from 'vitest'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { GitLabWorkItem } from '../../../../shared/gitlab-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { GitPushTarget } from '../../../../shared/worktree/types'
import type { SmartSourceSelection } from './source-selection-decisions'
import { useGitHubSourceApplication } from './github-source-application'
import { useSourceIdentityActions } from './source-identity-actions'
import { useBranchStartPointActions } from './branch-start-point-actions'
import { useGitHubProviderSelection } from './github-provider-selection'
import { useGitLabProviderSelection } from './gitlab-provider-selection'
import { useIssueSourceActions } from './issue-source-actions'
import { useTargetChangeActions } from './target-change-actions'
import { useProjectTargetActions } from './project-target-actions'
import { useWorkItemSourceActions } from './work-item-source-actions'
import { useGitHubSubmitResolution } from './github-submit-resolution'
import * as decisions from './composer-decisions'

export const repo = {
  id: 'fixture-repo',
  path: '/repos/fixture',
  displayName: 'Fixture',
  badgeColor: '',
  addedAt: 0
}
const folderGroup: ProjectGroup = {
  id: 'folder',
  name: 'Folder',
  parentPath: '/repos',
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 0,
  updatedAt: 0
}
const replacementRepo = { ...repo, id: 'replacement-repo', path: '/repos/replacement' }
export const pr: GitHubWorkItem = {
  id: 'pr-2',
  type: 'pr',
  number: 2,
  title: 'Fix export',
  state: 'open',
  url: 'https://github.com/fixture/repo/pull/2',
  labels: [],
  updatedAt: '',
  author: null,
  repoId: repo.id
}
export const mr: GitLabWorkItem = {
  id: 'mr-2',
  number: 2,
  title: 'Fix export',
  labels: [],
  updatedAt: '',
  author: null,
  repoId: repo.id,
  type: 'mr',
  state: 'opened',
  url: 'https://gitlab.com/fixture/repo/-/merge_requests/2'
}
export function useReviewBaseSelectionFixture(initialReview?: GitHubWorkItem) {
  const [name, setName] = useState('')
  const [linkedWorkItem, setLinkedWorkItem] = useState<LinkedWorkItemSummary | null>(
    initialReview ?? null
  )
  const [baseBranch, setBaseBranch] = useState<string | undefined>()
  const [repoId, setRepoId] = useState(repo.id)
  const [selectedProjectGroupId, setSelectedProjectGroupId] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [pushTarget, setPushTarget] = useState<GitPushTarget | undefined>()
  const [compareBaseRef, setCompareBaseRef] = useState<string | undefined>()
  const [branchNameOverride, setBranchNameOverride] = useState<string | undefined>()
  const [branchNameOverridePreservesNameEdits, setBranchNameOverridePreservesNameEdits] =
    useState(false)
  const [initialSelection] = useState(() =>
    decisions.getInitialGitHubPrStartPointSelection({
      item: initialReview,
      linkedWorkItem: initialReview,
      repoId: repo.id
    })
  )
  const common = {
    name,
    setName,
    linkedWorkItem,
    setLinkedWorkItem,
    baseBranch,
    setBaseBranch,
    lastAutoNameRef: useRef(''),
    branchAutoNameRef: useRef(''),
    smartSourceSelectionRef: useRef<SmartSourceSelection | null>(initialSelection),
    lastAutoNoteRef: useRef(''),
    noteRef: useRef(''),
    initialProjectGroupAppliedRef: useRef(false),
    selectedRepoGitHubSourceContext: null,
    branchNameOverride,
    branchNameOverridePreservesNameEdits,
    forkPushWarning: null,
    pushTarget,
    baseBranchNamesWorkspace: false,
    isProjectGroupTarget: selectedProjectGroupId !== null,
    settings: null,
    eligibleRepos: [repo, replacementRepo],
    selectedRepo: repo,
    selectedRepoIsGit: true,
    folderSourceRepos: [],
    setBranchNameOverride,
    setBranchNameOverridePreservesNameEdits,
    setCreateError: vi.fn(),
    setForkPushWarning: vi.fn(),
    setLinkDebouncedQuery: vi.fn(),
    setLinkDirectItem: vi.fn(),
    setLinkPopoverOpen: vi.fn(),
    setLinkQuery: vi.fn(),
    setLinkedGitLabIssue: vi.fn(),
    setLinkedGitLabMR: vi.fn(),
    setLinkedIssue: vi.fn(),
    setLinkedPR: vi.fn(),
    setLinkedTaskSourceContext: vi.fn(),
    setPushTarget,
    setReuseEligibleBranch: vi.fn(),
    setReuseSelectedBranch: vi.fn(),
    setCompareBaseRef,
    setStartFromResetHint: vi.fn(),
    setBaseBranchNamesWorkspace: vi.fn(),
    setNote,
    setProjectError: vi.fn(),
    setSelectedProjectGroupId,
    setSparseDirectories: vi.fn(),
    setSparseEnabled: vi.fn(),
    setSparseSelectedPresetId: vi.fn(),
    handleRepoChange: vi.fn()
  }
  const application = useGitHubSourceApplication(common)
  const identity = useSourceIdentityActions({ ...common, ...application })
  const branch = useBranchStartPointActions({ ...common, ...application, ...identity })
  const issues = useIssueSourceActions(common)
  const target = useTargetChangeActions({
    ...common,
    decisions,
    repoId,
    setRepoId,
    folderSourceRepos: selectedProjectGroupId ? [repo, replacementRepo] : [],
    hostOptions: [],
    projectHostSetupOptions: [],
    selectedRepoProjectId: null,
    setSelectedProjectHostSetupOverrideId: vi.fn()
  })
  const project = useProjectTargetActions({
    ...common,
    handleRepoChange: target.handleRepoChange,
    actionableHostIds: new Set([LOCAL_EXECUTION_HOST_ID]),
    projectGroups: [folderGroup],
    projectHostSetups: [],
    projects: [],
    repos: [repo, replacementRepo],
    setRepoId,
    selectedWorkspaceTarget: { status: 'unavailable', reason: 'no-eligible-repo' },
    workspaceHostScope: LOCAL_EXECUTION_HOST_ID
  })
  const workItem = useWorkItemSourceActions({
    ...common,
    repoId,
    reuseEligibleBranch: null,
    worktreesByRepo: {}
  })
  const github = useGitHubProviderSelection({ ...common, ...application, ...branch })
  const gitlab = useGitLabProviderSelection({ ...common, ...identity, ...branch })
  const submit = useGitHubSubmitResolution(common)
  return {
    ...github,
    ...gitlab,
    ...identity,
    ...branch,
    ...issues,
    ...target,
    ...project,
    ...workItem,
    ...submit,
    name,
    linkedWorkItem,
    baseBranch,
    note,
    pushTarget,
    compareBaseRef,
    branchNameOverride,
    repoId,
    selectedProjectGroupId
  }
}
