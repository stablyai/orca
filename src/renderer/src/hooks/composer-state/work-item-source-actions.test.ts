// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { useWorkspaceIdentityState } from './workspace-identity-state'
import { useWorkItemSourceActions } from './work-item-source-actions'
import type { SmartSourceSelection } from './source-selection-decisions'
import { resolveComposerBranchNameOverrideForCreate } from '../../../../shared/composer-branch-selection'

afterEach(cleanup)

it('records reuse intent for remote and local selections and clears it on Advanced edits', () => {
  const { result } = renderHook(() => {
    const identity = useWorkspaceIdentityState({
      initialBaseBranch: undefined,
      initialLinearBranchName: undefined,
      initialLinkedWorkItem: null,
      linkedWorkItem: null,
      linkedWorkItemSeedIdentity: null,
      name: '',
      newWorkspaceDraft: null,
      persistDraft: false,
      selectedRepoConnectionId: null,
      selectedRepoRuntimeEnvironmentId: null,
      settings: null
    })
    const actions = useWorkItemSourceActions({
      ...identity,
      branchAutoNameRef: useRef(''),
      lastAutoNameRef: useRef(''),
      smartSourceSelectionRef: useRef<SmartSourceSelection | null>(null),
      name: '',
      repoId: 'repo-1',
      setName: vi.fn(),
      worktreesByRepo: {}
    })
    return { identity, actions }
  })

  act(() => result.current.actions.handleSmartBranchSelect('origin/feature/test', 'feature/test'))
  expect(result.current.identity.branchIntent).toBe('open-existing-v2')
  expect(result.current.identity.branchNameOverride).toBe('feature/test')
  act(() => result.current.identity.setBranchNameOverride('feature/test'))
  expect(result.current.identity.branchIntent).toBeUndefined()
  act(() => result.current.actions.handleSmartBranchSelect('feature/test', 'feature/test'))
  expect(result.current.identity.branchIntent).toBe('open-existing-v2')
  act(() => result.current.actions.handleReuseSelectedBranchChange(false))
  expect(result.current.identity.branchIntent).toBe('create-new')
  expect(result.current.identity.branchNameOverride).toBeUndefined()
  act(() => result.current.actions.handleReuseSelectedBranchChange(true))
  expect(result.current.identity.branchIntent).toBe('open-existing-v2')
  expect(result.current.identity.branchNameOverride).toBe('feature/test')
})

it('defaults to the existing remote branch while preserving a custom workspace name', () => {
  const { result } = renderHook(() => {
    const [name, setName] = useState('Review workspace')
    const identity = useWorkspaceIdentityState({
      initialBaseBranch: undefined,
      initialLinearBranchName: undefined,
      initialLinkedWorkItem: null,
      linkedWorkItem: null,
      linkedWorkItemSeedIdentity: null,
      name,
      newWorkspaceDraft: null,
      persistDraft: false,
      selectedRepoConnectionId: null,
      selectedRepoRuntimeEnvironmentId: null,
      settings: null
    })
    const actions = useWorkItemSourceActions({
      ...identity,
      branchAutoNameRef: useRef(''),
      lastAutoNameRef: useRef(''),
      smartSourceSelectionRef: useRef<SmartSourceSelection | null>(null),
      name,
      repoId: 'repo',
      setName,
      worktreesByRepo: {}
    })
    return { identity, actions, name, setName }
  })
  act(() =>
    result.current.actions.handleSmartBranchSelect(
      'refs/remotes/origin/feature/test',
      'feature/test'
    )
  )
  expect(result.current.name).toBe('Review workspace')
  expect(result.current.identity.reuseSelectedBranch).toBe(true)
  act(() => result.current.setName('Renamed review workspace'))
  expect(result.current.identity.baseBranch).toBe('refs/remotes/origin/feature/test')
  expect(result.current.identity.branchIntent).toBe('open-existing-v2')
  expect(
    resolveComposerBranchNameOverrideForCreate({
      branchNameOverride: result.current.identity.branchNameOverride,
      branchAutoName: 'feature/test',
      workspaceName: result.current.name,
      preserveWorkspaceNameEdits: result.current.identity.branchNameOverridePreservesNameEdits
    })
  ).toBe('feature/test')
})
