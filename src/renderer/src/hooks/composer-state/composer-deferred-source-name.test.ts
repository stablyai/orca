// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { GitLabWorkItem } from '../../../../shared/gitlab-types'
import type { GitHubPrStartPoint } from '../../../../shared/worktree/types'
import type { SmartGitHubPrStartPointSelection } from './source-selection-decisions'
import { useGitHubSourceApplication } from './github-source-application'
import { useSourceIdentityActions } from './source-identity-actions'
import { useBranchStartPointActions } from './branch-start-point-actions'
import { useGitHubProviderSelection } from './github-provider-selection'
import { useGitLabProviderSelection } from './gitlab-provider-selection'

const repo = {
  id: 'fixture-repo',
  path: '/repos/fixture',
  displayName: 'Fixture',
  badgeColor: '',
  addedAt: 0
}
const pr: GitHubWorkItem = {
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
const mr: GitLabWorkItem = {
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
let originalApi: PropertyDescriptor | undefined
const resolvePrBase = vi.fn<Window['api']['worktrees']['resolvePrBase']>()
const resolveMrBase = vi.fn<Window['api']['worktrees']['resolveMrBase']>()

beforeEach(() => {
  originalApi = Object.getOwnPropertyDescriptor(window, 'api')
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { worktrees: { resolvePrBase, resolveMrBase } }
  })
})
afterEach(() => {
  vi.resetAllMocks()
  if (originalApi) {
    Object.defineProperty(window, 'api', originalApi)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

function deferred() {
  let resolve!: (value: GitHubPrStartPoint) => void
  const promise = new Promise<GitHubPrStartPoint>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function useDeferredSource() {
  const [name, setName] = useState('')
  const [linkedWorkItem, setLinkedWorkItem] = useState<LinkedWorkItemSummary | null>(null)
  const [baseBranch, setBaseBranch] = useState<string | undefined>()
  const common = {
    name,
    setName,
    linkedWorkItem,
    setLinkedWorkItem,
    baseBranch,
    setBaseBranch,
    lastAutoNameRef: useRef(''),
    branchAutoNameRef: useRef(''),
    smartGitHubPrStartPointSelectionRef: useRef<SmartGitHubPrStartPointSelection | null>(null),
    lastAutoNoteRef: useRef(''),
    noteRef: useRef(''),
    initialProjectGroupAppliedRef: useRef(false),
    selectedRepoGitHubSourceContext: null,
    branchNameOverride: undefined,
    branchNameOverridePreservesNameEdits: false,
    forkPushWarning: null,
    pushTarget: undefined,
    baseBranchNamesWorkspace: false,
    isProjectGroupTarget: false,
    settings: null,
    eligibleRepos: [repo],
    selectedRepo: repo,
    setBranchNameOverride: vi.fn(),
    setBranchNameOverridePreservesNameEdits: vi.fn(),
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
    setPushTarget: vi.fn(),
    setReuseEligibleBranch: vi.fn(),
    setReuseSelectedBranch: vi.fn(),
    setCompareBaseRef: vi.fn(),
    setStartFromResetHint: vi.fn(),
    setBaseBranchNamesWorkspace: vi.fn(),
    setNote: vi.fn(),
    setProjectError: vi.fn(),
    setSelectedProjectGroupId: vi.fn(),
    setSparseDirectories: vi.fn(),
    setSparseEnabled: vi.fn(),
    setSparseSelectedPresetId: vi.fn(),
    handleRepoChange: vi.fn()
  }
  const application = useGitHubSourceApplication(common)
  const identity = useSourceIdentityActions({ ...common, ...application })
  const branch = useBranchStartPointActions({ ...common, ...application, ...identity })
  const github = useGitHubProviderSelection({ ...common, ...application, ...branch })
  const gitlab = useGitLabProviderSelection({ ...common, ...identity, ...branch })
  return { ...github, ...gitlab, ...identity, ...branch, name, linkedWorkItem, baseBranch }
}

describe('name ownership while resolving review bases', () => {
  it.each(['github', 'gitlab'])(
    'keeps an Advanced name while %s resolves its base',
    async (provider) => {
      const pending = deferred()
      resolvePrBase.mockReturnValue(pending.promise)
      resolveMrBase.mockReturnValue(pending.promise)
      const { result } = renderHook(useDeferredSource)
      act(() => {
        if (provider === 'github') {
          result.current.handleSmartGitHubItemSelect(pr)
        } else {
          result.current.handleSmartGitLabItemSelect(mr)
        }
      })
      act(() => result.current.handleNameValueChange('002'))
      await act(async () => {
        pending.resolve({ baseBranch: 'feature/export' })
        await pending.promise
      })

      expect(result.current.name).toBe('002')
      expect(result.current.linkedWorkItem).toMatchObject({ provider, number: 2 })
      expect(result.current.baseBranch).toBe('feature/export')
    }
  )

  it.each(['github', 'gitlab'])(
    'still links and auto-names a direct %s Start-from selection',
    (provider) => {
      const { result } = renderHook(useDeferredSource)
      act(() => {
        if (provider === 'github') {
          result.current.handleBaseBranchPrSelect('feature/export', pr)
        } else {
          result.current.handleBaseBranchMrSelect('feature/export', mr)
        }
      })

      expect(result.current.name).toBe('fix-export')
      expect(result.current.linkedWorkItem).toMatchObject({ provider, number: 2 })
    }
  )
})
