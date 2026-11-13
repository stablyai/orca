import { afterEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { rememberAuthoritativelyRemovedWorktrees } from '@/store/slices/worktrees/listing/authoritative-worktree-removal-memory'
import { makeWorktree } from '../../../worktree-jump/worktree-jump-palette-test-fixtures'
import {
  markBranchSectionToggledByUser,
  readMergedBranchSectionRecord,
  type MergedBranchSectionOwner
} from './merged-branch-section-disclosure'

const previousWorktreesByRepo = useAppStore.getState().worktreesByRepo

afterEach(() => {
  useAppStore.setState({ worktreesByRepo: previousWorktreesByRepo })
})

it('prunes only checkouts proven gone, never a disconnected host’s workspaces', () => {
  const disconnected: MergedBranchSectionOwner = { id: 'repo-1::/remote/a', hostId: 'ssh:box' }
  const removedRemote: MergedBranchSectionOwner = { id: 'repo-1::/remote/b', hostId: 'ssh:box' }
  const removedLocal: MergedBranchSectionOwner = { id: 'repo-1::/local/c', hostId: 'local' }
  const recreated: MergedBranchSectionOwner = {
    id: 'repo-1::/local/d',
    hostId: 'local',
    instanceId: 'old'
  }
  const fillers = Array.from({ length: 520 }, (_, index) =>
    makeWorktree(`repo-1::/local/filler-${index}`, `filler-${index}`, { hostId: 'local' })
  )
  useAppStore.setState({
    worktreesByRepo: {
      'repo-1': [
        ...fillers,
        makeWorktree(recreated.id, 'd', { hostId: 'local', instanceId: 'new' })
      ]
    }
  })
  rememberAuthoritativelyRemovedWorktrees('ssh:box', [removedRemote.id])

  for (const owner of [disconnected, removedRemote, removedLocal, recreated, ...fillers]) {
    markBranchSectionToggledByUser(owner)
  }

  expect(readMergedBranchSectionRecord(disconnected).disclosure.kind).toBe('user')
  expect(readMergedBranchSectionRecord(fillers[0]).disclosure.kind).toBe('user')
  expect(readMergedBranchSectionRecord(removedRemote).disclosure.kind).toBe('untouched')
  expect(readMergedBranchSectionRecord(removedLocal).disclosure.kind).toBe('untouched')
  expect(readMergedBranchSectionRecord(recreated).disclosure.kind).toBe('untouched')
})
