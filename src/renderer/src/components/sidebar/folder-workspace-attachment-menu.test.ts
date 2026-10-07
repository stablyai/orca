import { describe, expect, it } from 'vitest'
import { makeWorkspaceLineage, makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import type { WorkspaceKey } from '../../../../shared/folder-workspace-types'
import {
  canShowFolderParentAttachment,
  hasFolderWorkspaceParentLink,
  hasWorktreeParentLink,
  isFolderParentAttachmentDisabled
} from './worktree-context-menu-policy'

describe('folder attachment menu policy', () => {
  it('offers single Git rows independently of Git-parent candidate counts', () => {
    expect(
      canShowFolderParentAttachment({
        worktreeId: 'repo::/primary',
        repoKind: 'git',
        isMultiContext: false
      })
    ).toBe(true)
  })
  it('does not offer folder cards, non-Git folder repos, or multi-selection', () => {
    expect(
      canShowFolderParentAttachment({ worktreeId: 'folder:ticket', isMultiContext: false })
    ).toBe(false)
    expect(
      canShowFolderParentAttachment({
        worktreeId: 'repo::/folder',
        repoKind: 'folder',
        isMultiContext: false
      })
    ).toBe(false)
    expect(
      canShowFolderParentAttachment({
        worktreeId: 'repo::/child',
        repoKind: 'git',
        isMultiContext: true
      })
    ).toBe(false)
  })
  it('disables deletion and pending writes but not an idle primary checkout', () => {
    expect(isFolderParentAttachmentDisabled({ isDeleting: true, pending: false })).toBe(true)
    expect(isFolderParentAttachmentDisabled({ isDeleting: false, pending: true })).toBe(true)
    expect(isFolderParentAttachmentDisabled({ isDeleting: false, pending: false })).toBe(false)
  })
  it('detects only folder-workspace parents for the removal label', () => {
    const child = { id: 'repo::/child', instanceId: 'current' }
    const edge = (parentWorkspaceKey: WorkspaceKey, childInstanceId?: string) => ({
      'worktree:repo::/child': makeWorkspaceLineage({ parentWorkspaceKey, childInstanceId })
    })
    expect(hasFolderWorkspaceParentLink(child, edge('folder:ticket'))).toBe(true)
    expect(hasFolderWorkspaceParentLink(child, edge('worktree:repo::/parent'))).toBe(false)
    expect(hasFolderWorkspaceParentLink(child, {})).toBe(false)
    expect(hasFolderWorkspaceParentLink(child, edge('folder:ticket', 'current'))).toBe(true)
    expect(hasFolderWorkspaceParentLink(child, edge('folder:ticket', 'old-checkout'))).toBe(false)
    const fullChild = makeWorktree({ ...child, repoId: 'repo' })
    expect(hasWorktreeParentLink(fullChild, {}, edge('folder:ticket', 'old-checkout'))).toBe(false)
    expect(hasWorktreeParentLink(fullChild, {}, edge('folder:ticket', 'current'))).toBe(true)
  })
})
