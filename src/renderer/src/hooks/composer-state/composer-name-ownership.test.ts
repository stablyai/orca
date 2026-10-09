// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { useRef, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import { getSmartGitHubSubmitResolution } from '@/lib/smart-github-submit'
import { useGitHubSourceApplication } from './github-source-application'
import { useSourceIdentityActions } from './source-identity-actions'
import { useQuickSubmitSourcePreparation } from './quick-submit-source-preparation'
import * as decisions from './composer-decisions'
import type {
  PendingSmartGitHubSubmitResolution,
  SmartGitHubPrStartPointSelection
} from './source-selection-decisions'

function issue(number: number): GitHubWorkItem {
  return {
    id: `issue-${number}`,
    type: 'issue',
    number,
    title: 'Fix export',
    state: 'open',
    url: `https://github.com/fixture/repo/issues/${number}`,
    labels: [],
    updatedAt: '',
    author: null,
    repoId: 'fixture-repo'
  }
}

function useNameOwnership(draft?: { name: string; linkedWorkItem: LinkedWorkItemSummary }) {
  const [name, setName] = useState(draft?.name ?? '')
  const [linkedWorkItem, setLinkedWorkItem] = useState<LinkedWorkItemSummary | null>(
    draft?.linkedWorkItem ?? null
  )
  const lastAutoNameRef = useRef(
    decisions.getInitialAutoManagedWorkspaceName({
      initialName: '',
      draftName: draft?.name,
      draftLinkedWorkItem: draft?.linkedWorkItem
    })
  )
  const common = {
    name,
    setName,
    linkedWorkItem,
    setLinkedWorkItem,
    lastAutoNameRef,
    branchAutoNameRef: useRef(''),
    smartGitHubPrStartPointSelectionRef: useRef<SmartGitHubPrStartPointSelection | null>(null),
    selectedRepoGitHubSourceContext: null,
    branchNameOverride: undefined,
    branchNameOverridePreservesNameEdits: false,
    forkPushWarning: null,
    pushTarget: undefined,
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
    setReuseSelectedBranch: vi.fn()
  }
  const application = useGitHubSourceApplication(common)
  const identity = useSourceIdentityActions({ ...common, ...application })
  const source = useQuickSubmitSourcePreparation({
    ...common,
    baseBranch: 'main',
    compareBaseRef: undefined,
    disabledTuiAgents: [],
    effectiveLinkedPR: null,
    decisions,
    fallbackCreatureName: 'otter',
    linkedGitLabMR: null,
    parsedLinkedIssueNumber: linkedWorkItem?.number ?? null
  })
  return {
    ...application,
    ...identity,
    name,
    linkedWorkItem,
    prepare: (resolution: PendingSmartGitHubSubmitResolution = { kind: 'none' }) =>
      source.prepareQuickSubmitSource(resolution, null, name || 'otter')
  }
}

describe('workspace name ownership after linking a source', () => {
  it.each(['347', '002'])('submits Advanced name %s as user input', (name) => {
    const { result } = renderHook(() => useNameOwnership())
    act(() => result.current.applyLinkedWorkItem(issue(Number(name))))
    act(() => result.current.handleNameValueChange(name))

    expect(result.current.prepare()).toMatchObject({
      workspaceName: name,
      nameIsAutoManaged: false,
      submitLinkedWorkItem: { number: Number(name), url: issue(Number(name)).url }
    })
  })

  it.each([2, 347])('preserves an edited name when source #%s replaces the source', (number) => {
    const { result } = renderHook(() => useNameOwnership())
    act(() => result.current.applyLinkedWorkItem(issue(2)))
    act(() => result.current.handleNameValueChange('002'))
    act(() => result.current.applyLinkedWorkItem(issue(number)))

    expect(result.current.name).toBe('002')
    expect(result.current.prepare()).toMatchObject({
      workspaceName: '002',
      nameIsAutoManaged: false,
      submitLinkedWorkItem: { number }
    })
  })

  it('restores manual ownership from an existing draft without a new persisted flag', () => {
    const { result } = renderHook(() => useNameOwnership({ name: '002', linkedWorkItem: issue(2) }))

    expect(result.current.prepare()).toMatchObject({
      workspaceName: '002',
      nameIsAutoManaged: false
    })
  })

  it('keeps manual ownership when the linked source is removed', () => {
    const { result } = renderHook(() => useNameOwnership())
    act(() => result.current.applyLinkedWorkItem(issue(2)))
    act(() => result.current.handleNameValueChange('002'))
    act(() => result.current.handleRemoveLinkedWorkItem())

    expect(result.current.prepare()).toMatchObject({
      workspaceName: '002',
      nameIsAutoManaged: false,
      submitLinkedWorkItem: null
    })
  })

  it.each(['347', '002', '#347'])('still auto-names a source picked from query %s', (query) => {
    const { result } = renderHook(() => useNameOwnership())
    act(() => result.current.handleNameValueChange(query))
    act(() => result.current.applyLinkedWorkItem(issue(query === '002' ? 2 : 347)))

    expect(result.current.prepare()).toMatchObject({
      workspaceName: 'fix-export',
      nameIsAutoManaged: true
    })
  })

  it('restores automatic naming when the Advanced name is cleared', () => {
    const { result } = renderHook(() => useNameOwnership())
    act(() => result.current.applyLinkedWorkItem(issue(2)))
    act(() => result.current.handleNameValueChange('002'))
    act(() => result.current.handleNameValueChange(''))

    expect(result.current.prepare()).toMatchObject({
      workspaceName: 'fix-export',
      nameIsAutoManaged: true
    })
  })

  it('keeps automatic ownership when a generated name is restored or refreshed', () => {
    const { result } = renderHook(() =>
      useNameOwnership({ name: 'fix-export', linkedWorkItem: issue(2) })
    )
    act(() => result.current.applyLinkedWorkItem({ ...issue(2), title: 'Fix refreshed export' }))

    expect(result.current.prepare()).toMatchObject({
      workspaceName: 'fix-refreshed-export',
      nameIsAutoManaged: true
    })
  })

  it('still resolves a pasted lookup at submit time as an automatic name', () => {
    const { result } = renderHook(() => useNameOwnership())
    act(() => result.current.handleNameValueChange(issue(2).url))

    expect(
      result.current.prepare({
        ...getSmartGitHubSubmitResolution(issue(2)),
        kind: 'metadata-only'
      })
    ).toMatchObject({ workspaceName: 'fix-export', nameIsAutoManaged: true })
  })

  it('keeps an Advanced name when the selected pull request resolves its base at submit time', () => {
    const pr: GitHubWorkItem = {
      ...issue(2),
      type: 'pr',
      url: 'https://github.com/fixture/repo/pull/2'
    }
    const { result } = renderHook(() => useNameOwnership())
    act(() => result.current.applyLinkedWorkItem(pr))
    act(() => result.current.handleNameValueChange('002'))

    expect(
      result.current.prepare({
        ...getSmartGitHubSubmitResolution(pr),
        kind: 'pr-start-point',
        baseBranch: 'feature/export'
      })
    ).toMatchObject({ workspaceName: '002', nameIsAutoManaged: false, submitLinkedPR: 2 })
  })
})
