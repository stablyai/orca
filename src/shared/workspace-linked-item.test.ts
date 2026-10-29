import { describe, expect, it } from 'vitest'
import { areWorkspaceLinkedItemsEqual, normalizeWorkspaceLinkedItem } from './workspace-linked-item'
import type { WorkspaceLinkedItem } from './worktree/types'

const azureDevOpsItem: WorkspaceLinkedItem = {
  provider: 'azure-devops',
  type: 'issue',
  number: 288,
  title: 'Ship the backlog view',
  url: 'https://dev.azure.com/contoso/Contoso/_workitems/edit/288',
  azureDevOpsIdentifier: '288',
  repoId: 'repo-1'
}

describe('normalizeWorkspaceLinkedItem', () => {
  it('round-trips an Azure DevOps work item with its identifier', () => {
    expect(normalizeWorkspaceLinkedItem({ ...azureDevOpsItem })).toEqual(azureDevOpsItem)
    expect(
      normalizeWorkspaceLinkedItem({ ...azureDevOpsItem, azureDevOpsIdentifier: '  ' })
    ).toEqual({ ...azureDevOpsItem, azureDevOpsIdentifier: undefined })
  })

  it('rejects unknown providers', () => {
    expect(normalizeWorkspaceLinkedItem({ ...azureDevOpsItem, provider: 'bitbucket' })).toBeNull()
  })
})

describe('areWorkspaceLinkedItemsEqual (azure-devops)', () => {
  it('separates items that differ only by the Azure DevOps identifier', () => {
    expect(areWorkspaceLinkedItemsEqual(azureDevOpsItem, { ...azureDevOpsItem })).toBe(true)
    expect(
      areWorkspaceLinkedItemsEqual(azureDevOpsItem, {
        ...azureDevOpsItem,
        azureDevOpsIdentifier: '289'
      })
    ).toBe(false)
  })
})
