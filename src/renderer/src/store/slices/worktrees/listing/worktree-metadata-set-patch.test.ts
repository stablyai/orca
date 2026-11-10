import { describe, expect, it } from 'vitest'
import type { WorkspaceAttachment } from '../../../../../../shared/worktree/types'
import { useAppStore } from '../../..'
import {
  makeRepo,
  makeWorktree
} from '../../../../components/worktree-jump/worktree-jump-palette-test-fixtures'
import { selectWorktreesByRepo } from '../../../workspaces/catalog/workspace-record-fields'
import { patchWorktreeMetadataSet } from './worktree-metadata-set-patch'

const ID = 'repo-1::/work/orca'
const titled = (title: string): WorkspaceAttachment[] => [
  { provider: 'github', type: 'issue', number: 42, title }
]

function state() {
  return {
    ...useAppStore.getInitialState(),
    repos: [makeRepo()],
    worktreesByRepo: {
      'repo-1': [
        makeWorktree(ID, 'local orca', { hostId: 'local', linkedIssue: 42 }),
        makeWorktree(ID, 'ssh orca', { hostId: 'ssh:build-box', linkedIssue: 42 })
      ]
    }
  }
}

function record(seq: number, title: string, epoch = 'e1') {
  return {
    hostId: 'ssh:build-box' as const,
    epoch,
    seq,
    id: `ssh:build-box::${ID}`,
    repoId: 'repo-1',
    worktreeId: ID,
    row: {
      linkedItems: titled(title),
      linkedWorkItem: null,
      linkedIssue: 42,
      linkedTaskSourceContext: null
    }
  }
}

describe('addressed workspace metadata records', () => {
  it('update only the named host row and ignore a replayed older record', () => {
    const first = patchWorktreeMetadataSet(
      state(),
      record(2, 'Repair authentication'),
      'ssh:build-box'
    )
    const rows = selectWorktreesByRepo({ ...state(), ...first })['repo-1']
    expect(rows.find((row) => row.hostId === 'ssh:build-box')?.linkedItems).toEqual(
      titled('Repair authentication')
    )
    expect(rows.find((row) => row.hostId === 'local')?.linkedItems).toBeUndefined()

    const applied = { ...state(), ...first }
    expect(patchWorktreeMetadataSet(applied, record(1, 'Old title'), 'ssh:build-box')).toBe(applied)
  })
})
