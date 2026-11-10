import { describe, expect, it } from 'vitest'
import type { WorkspaceAttachment } from '../../../../../../shared/worktree/types'
import type { AppState } from '../../../types'
import { useAppStore } from '../../..'
import {
  makeRepo,
  makeWorktree
} from '../../../../components/worktree-jump/worktree-jump-palette-test-fixtures'
import { selectWorktreesByRepo } from '../../../workspaces/catalog/workspace-record-fields'
import { patchWorktreeMetadataSet, reapplyPendingIssueTitles } from './worktree-metadata-set-patch'

const ID = 'repo-1::/work/orca'
const issue = (title?: string): WorkspaceAttachment[] => [
  { provider: 'github', type: 'issue', number: 42, ...(title ? { title } : {}) }
]
const local = { kind: 'local' as const }

function state(linkedItems: WorkspaceAttachment[] = issue()) {
  const linkedIssue = linkedItems.length > 0 ? 42 : null
  return {
    ...useAppStore.getInitialState(),
    repos: [makeRepo()],
    worktreesByRepo: {
      'repo-1': [
        makeWorktree(ID, 'local orca', { hostId: 'local', linkedIssue, linkedItems }),
        makeWorktree(ID, 'ssh orca', { hostId: 'ssh:build-box', linkedIssue, linkedItems })
      ]
    }
  }
}

function record(seq: number, title: string, epoch: string) {
  return {
    kind: 'set' as const,
    domain: 'workspaceMetadata' as const,
    hostId: 'ssh:build-box' as const,
    epoch,
    seq,
    id: `ssh:build-box::${ID}`,
    repoId: 'repo-1',
    worktreeId: ID,
    row: {
      linkedItems: issue(title),
      linkedWorkItem: null,
      linkedIssue: 42,
      linkedTaskSourceContext: null
    }
  }
}

function sshRowLinks(value: AppState) {
  return selectWorktreesByRepo(value)['repo-1'].find((row) => row.hostId === 'ssh:build-box')
    ?.linkedItems
}

describe('addressed workspace metadata records', () => {
  it('title only the named host row and ignore a replayed older record', () => {
    const titled = {
      ...state(),
      ...patchWorktreeMetadataSet(state(), record(2, 'Fix login', 'e1'), local)
    }
    expect(sshRowLinks(titled)).toEqual(issue('Fix login'))
    expect(
      selectWorktreesByRepo(titled)['repo-1'].find((row) => row.hostId === 'local')?.linkedItems
    ).toEqual(issue())
    expect(patchWorktreeMetadataSet(titled, record(1, 'Old title', 'e1'), local)).toBe(titled)
  })

  it('refills a title a late listing dropped, and never brings back an unlinked issue', () => {
    const titled = {
      ...state(),
      ...patchWorktreeMetadataSet(state(), record(5, 'Fix login', 'e2'), local)
    }
    // A listing that read metadata before the title was saved lands afterwards with the bare link.
    const late = { ...titled, worktreesByRepo: state().worktreesByRepo }
    expect(sshRowLinks({ ...late, ...reapplyPendingIssueTitles(late, titled) })).toEqual(
      issue('Fix login')
    )

    // The user unlinked the issue before a record for it arrived.
    const unlinked = state([])
    expect(patchWorktreeMetadataSet(unlinked, record(1, 'Fix login', 'e3'), local)).toBe(unlinked)
  })

  it('titles a link that the row lists only after its record arrived', () => {
    // The record beats the listing that adds the link to an existing row.
    const before = state([])
    expect(patchWorktreeMetadataSet(before, record(1, 'Fix login', 'e4'), local)).toBe(before)
    const listed = state()
    expect(sshRowLinks({ ...listed, ...reapplyPendingIssueTitles(listed, before) })).toEqual(
      issue('Fix login')
    )
  })
})
