// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { useWorkspaceIdentityState } from './workspace-identity-state'
import { useWorkItemSourceActions } from './work-item-source-actions'
import type { SmartSourceSelection } from './source-selection-decisions'

afterEach(cleanup)

it('records existing intent only for a remote picker selection and clears it on Advanced edits', () => {
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
  expect(result.current.identity.branchIntent).toBe('open-existing')
  expect(result.current.identity.branchNameOverride).toBe('feature/test')
  act(() => result.current.identity.setBranchNameOverride('feature/test'))
  expect(result.current.identity.branchIntent).toBeUndefined()
  act(() => result.current.actions.handleSmartBranchSelect('feature/test', 'feature/test'))
  expect(result.current.identity.branchIntent).toBeUndefined()
})
