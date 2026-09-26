import { describe, expect, it } from 'vitest'
import {
  buildContinuationTargetGroups,
  findContinuationTargetOption,
  isContinuationTargetSelectable,
  type ContinuationTargetOption
} from './continuation-target-options'
import { resolveFullTranscriptBlockedReason } from './use-continuation-target-selection'
import { AI_VAULT_HANDOFF_MAX_TRANSFER_BYTES } from '../../../../shared/ai-vault-session-handoff'
import type { AiVaultSessionResumeTargetState } from '@/components/right-sidebar/ai-vault-session-resume'
import type { Worktree } from '../../../../shared/worktree/types'

const HOST_NAMES = {
  runtimeEnvironments: [{ id: 'ed283559-cd56', name: 'Demo Server' }],
  sshTargetLabels: new Map([['hetzner', 'Hetzner VPS']])
}

function makeWorktree(fields: Pick<Worktree, 'id' | 'hostId' | 'displayName' | 'path'>): Worktree {
  return {
    repoId: 'repo-1',
    head: '',
    branch: 'main',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...fields
  }
}

const LOCAL_WORKTREE = makeWorktree({
  id: 'repo-1::/repo/local',
  hostId: 'local',
  displayName: 'local-work',
  path: '/repo/local'
})

const SSH_WORKTREE = makeWorktree({
  id: 'repo-1::/srv/remote',
  hostId: 'ssh:hetzner',
  displayName: 'remote-work',
  path: '/srv/remote'
})

const SESSION_TRANSCRIPT = '/home/marabel/.claude/projects/orca/session.jsonl'

function makeState(worktrees: Worktree[]): AiVaultSessionResumeTargetState {
  return {
    folderWorkspaces: [],
    projectGroups: [],
    repos: [],
    worktreesByRepo: { 'repo-1': worktrees }
  }
}

describe('buildContinuationTargetGroups', () => {
  const worktrees = [SSH_WORKTREE, LOCAL_WORKTREE]
  const state = makeState(worktrees)

  it('groups workspaces by their owning host with local first', () => {
    const groups = buildContinuationTargetGroups({
      state,
      worktrees,
      hostNames: HOST_NAMES,
      source: { sessionFilePath: SESSION_TRANSCRIPT, sessionExecutionHostId: 'local' }
    })
    expect(groups.map((group) => group.executionHostId)).toEqual(['local', 'ssh:hetzner'])
    expect(groups[0]?.options.map((option) => option.label)).toEqual(['local-work'])
  })

  it('marks a same-host workspace as needing no transfer', () => {
    const groups = buildContinuationTargetGroups({
      state,
      worktrees,
      hostNames: HOST_NAMES,
      source: { sessionFilePath: SESSION_TRANSCRIPT, sessionExecutionHostId: 'local' }
    })
    const option = findContinuationTargetOption(groups, LOCAL_WORKTREE.id)
    expect(option?.bridge.kind).toBe('same-host')
    expect(isContinuationTargetSelectable(option!)).toBe(true)
  })

  it('offers a different host and records that its transcript must travel', () => {
    const groups = buildContinuationTargetGroups({
      state,
      worktrees,
      hostNames: HOST_NAMES,
      source: { sessionFilePath: SESSION_TRANSCRIPT, sessionExecutionHostId: 'local' }
    })
    const option = findContinuationTargetOption(groups, SSH_WORKTREE.id)
    expect(option?.bridge).toEqual({
      kind: 'transfer',
      sourceConnectionId: null,
      targetConnectionId: 'hetzner'
    })
    expect(isContinuationTargetSelectable(option!)).toBe(true)
  })

  it('returns no option for an unknown workspace id', () => {
    const groups = buildContinuationTargetGroups({
      state,
      worktrees,
      hostNames: HOST_NAMES,
      source: { sessionFilePath: SESSION_TRANSCRIPT, sessionExecutionHostId: 'local' }
    })
    expect(findContinuationTargetOption(groups, 'repo-1::/nope')).toBeNull()
    expect(findContinuationTargetOption(groups, null)).toBeNull()
  })
})

describe('host group labels', () => {
  const runtimeWorktree = makeWorktree({
    id: 'repo-1::/srv/demo',
    hostId: 'runtime:ed283559-cd56',
    displayName: 'main',
    path: '/srv/demo'
  })

  it('names a paired server instead of showing its raw environment id', () => {
    const worktrees = [runtimeWorktree]
    const groups = buildContinuationTargetGroups({
      state: makeState(worktrees),
      worktrees,
      hostNames: HOST_NAMES,
      source: { sessionFilePath: SESSION_TRANSCRIPT, sessionExecutionHostId: 'local' }
    })
    expect(groups.map((group) => group.hostLabel)).toEqual(['Demo Server'])
    expect(groups[0]?.hostLabel).not.toContain('ed283559')
  })

  it('names an SSH host from its saved label', () => {
    const worktrees = [SSH_WORKTREE]
    const groups = buildContinuationTargetGroups({
      state: makeState(worktrees),
      worktrees,
      hostNames: HOST_NAMES,
      source: { sessionFilePath: SESSION_TRANSCRIPT, sessionExecutionHostId: 'local' }
    })
    expect(groups[0]?.hostLabel).toBe('Hetzner VPS')
  })
})

describe('resolveFullTranscriptBlockedReason', () => {
  const option = (bridge: ContinuationTargetOption['bridge']): ContinuationTargetOption => ({
    workspaceId: 'w',
    label: 'main',
    workspacePath: '/w',
    executionHostId: 'local',
    bridge
  })

  it('blocks nothing on the same host, whatever the size', () => {
    expect(
      resolveFullTranscriptBlockedReason(option({ kind: 'same-host' }), 999_000_000)
    ).toBeNull()
  })

  it('blames the host, not the size, when the target stores no file', () => {
    expect(
      resolveFullTranscriptBlockedReason(option({ kind: 'inline', content: 'transcript-tail' }), 12)
    ).toBe('target-cannot-store')
  })

  it('blames the size only when a real copy would exceed the cap', () => {
    const transfer = option({
      kind: 'transfer',
      sourceConnectionId: null,
      targetConnectionId: 'hetzner'
    })
    expect(resolveFullTranscriptBlockedReason(transfer, 1024)).toBeNull()
    expect(
      resolveFullTranscriptBlockedReason(transfer, AI_VAULT_HANDOFF_MAX_TRANSFER_BYTES + 1)
    ).toBe('too-large')
  })
})
