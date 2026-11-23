// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { TaskSourceContext } from '../../../../../shared/work-items/task-source-context'
import { buildClickUpWorkspaceSource } from '../../../../../shared/new-workspace/workspace-source'
import { useAccountBackedWorkItemLink } from './account-backed-work-item-link'

const sourceContext: TaskSourceContext = {
  kind: 'task-source',
  provider: 'clickup',
  projectId: 'p1',
  hostId: 'local',
  providerIdentity: { provider: 'clickup', workspaceId: 'W1' }
}

function linkInput() {
  return {
    baseBranchNamesWorkspace: false,
    branchAutoNameRef: { current: 'old-branch' },
    lastAutoNameRef: { current: '' },
    linkedWorkItem: null,
    name: '',
    setBaseBranch: vi.fn(),
    setBranchNameOverride: vi.fn(),
    setBranchNameOverridePreservesNameEdits: vi.fn(),
    setCompareBaseRef: vi.fn(),
    setForkPushWarning: vi.fn(),
    setLinkedGitLabIssue: vi.fn(),
    setLinkedGitLabMR: vi.fn(),
    setLinkedIssue: vi.fn(),
    setLinkedPR: vi.fn(),
    setLinkedTaskSourceContext: vi.fn(),
    setLinkedWorkItem: vi.fn(),
    setName: vi.fn(),
    setPushTarget: vi.fn(),
    setReuseEligibleBranch: vi.fn(),
    setReuseSelectedBranch: vi.fn(),
    smartSourceSelectionRef: { current: null }
  }
}

describe('useAccountBackedWorkItemLink', () => {
  it('drops the branch picked for reuse when a task is linked', () => {
    const input = linkInput()
    const { result } = renderHook(() => useAccountBackedWorkItemLink(input))
    const linkedItem = buildClickUpWorkspaceSource({
      id: '86abc123',
      name: 'Fix the login',
      url: 'https://app.clickup.com/t/86abc123',
      customId: null
    })

    result.current(linkedItem, sourceContext, undefined)

    expect(input.setReuseEligibleBranch).toHaveBeenCalledWith(null)
    expect(input.setReuseSelectedBranch).toHaveBeenCalledWith(false)
    expect(input.setBranchNameOverride).toHaveBeenCalledWith(undefined)
    expect(input.setLinkedWorkItem).toHaveBeenCalledWith(linkedItem)
  })
})
