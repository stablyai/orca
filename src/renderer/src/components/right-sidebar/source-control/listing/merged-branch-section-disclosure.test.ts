import { afterEach, beforeEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import {
  announceAuthoritativeWorktreeRemovals,
  rememberAuthoritativelyRemovedWorktrees
} from '@/store/slices/worktrees/listing/authoritative-worktree-removal-memory'
import { makeRepo, makeWorktree } from '../../../worktree-jump/worktree-jump-palette-test-fixtures'
import {
  markBranchSectionToggledByUser,
  readMergedBranchSectionRecord,
  type MergedBranchSectionOwner
} from './merged-branch-section-disclosure'

const previous = useAppStore.getState()

beforeEach(() => {
  useAppStore.setState({ repos: [makeRepo()] })
})

afterEach(() => {
  useAppStore.setState({ repos: previous.repos, worktreesByRepo: previous.worktreesByRepo })
})

function owners(prefix: string, hostId: MergedBranchSectionOwner['hostId'], count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `repo-1::/${prefix}/${index}`,
    hostId
  }))
}

it('prunes only checkouts proven gone, never a disconnected host’s workspaces', () => {
  const disconnectedSsh: MergedBranchSectionOwner = { id: 'repo-1::/remote/a', hostId: 'ssh:box' }
  const disconnectedRuntime: MergedBranchSectionOwner = {
    id: 'repo-1::/paired/a',
    hostId: 'runtime:env'
  }
  const removedRemote: MergedBranchSectionOwner = { id: 'repo-1::/remote/b', hostId: 'ssh:box' }
  const removedLocal: MergedBranchSectionOwner = { id: 'repo-1::/local/c', hostId: 'local' }
  const removedProject: MergedBranchSectionOwner = {
    id: 'repo-2::/paired/e',
    hostId: 'runtime:env'
  }
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

  for (const owner of [
    disconnectedSsh,
    disconnectedRuntime,
    removedRemote,
    removedLocal,
    removedProject,
    recreated,
    ...fillers
  ]) {
    markBranchSectionToggledByUser(owner)
  }

  expect(readMergedBranchSectionRecord(disconnectedSsh).disclosure.kind).toBe('user')
  expect(readMergedBranchSectionRecord(disconnectedRuntime).disclosure.kind).toBe('user')
  expect(readMergedBranchSectionRecord(fillers[0]).disclosure.kind).toBe('user')
  expect(readMergedBranchSectionRecord(removedRemote).disclosure.kind).toBe('untouched')
  expect(readMergedBranchSectionRecord(removedLocal).disclosure.kind).toBe('untouched')
  expect(readMergedBranchSectionRecord(removedProject).disclosure.kind).toBe('untouched')
  expect(readMergedBranchSectionRecord(recreated).disclosure.kind).toBe('untouched')
})

it('drops every announced removal, beyond what the bounded removal memory keeps', () => {
  const runtimeOwners = owners('runtime-removed', 'runtime:env', 600)
  const sshOwners = owners('ssh-removed', 'ssh:box', 600)
  const runtimeSurvivor: MergedBranchSectionOwner = { id: 'repo-1::/kept/a', hostId: 'runtime:env' }
  const sameIdOtherHost: MergedBranchSectionOwner = { ...runtimeOwners[0], hostId: 'runtime:other' }
  for (const owner of [...runtimeOwners, ...sshOwners, runtimeSurvivor, sameIdOtherHost]) {
    markBranchSectionToggledByUser(owner)
  }

  rememberAuthoritativelyRemovedWorktrees(
    'runtime:env',
    runtimeOwners.map((owner) => owner.id)
  )
  rememberAuthoritativelyRemovedWorktrees(
    'ssh:box',
    sshOwners.map((owner) => owner.id)
  )

  expect(
    [...runtimeOwners, ...sshOwners].filter(
      (owner) => readMergedBranchSectionRecord(owner).disclosure.kind !== 'untouched'
    )
  ).toEqual([])
  expect(readMergedBranchSectionRecord(runtimeSurvivor).disclosure.kind).toBe('user')
  expect(readMergedBranchSectionRecord(sameIdOtherHost).disclosure.kind).toBe('user')
})

it('drops a paired workspace the user deleted', () => {
  const deleted: MergedBranchSectionOwner = {
    id: 'repo-1::/paired/deleted',
    hostId: 'runtime:env',
    instanceId: 'one'
  }
  markBranchSectionToggledByUser(deleted)

  announceAuthoritativeWorktreeRemovals('runtime:env', [deleted.id])

  expect(readMergedBranchSectionRecord(deleted).disclosure.kind).toBe('untouched')
})
