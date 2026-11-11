import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceAttachment } from '../../../../../../shared/worktree/types'
import type { AppState } from '../../../types'
import { useAppStore } from '../../..'
import {
  makeRepo,
  makeWorktree
} from '../../../../components/worktree-jump/worktree-jump-palette-test-fixtures'
import { selectWorktreesByRepo } from '../../../workspaces/catalog/workspace-record-fields'
import { patchWorktreeMetadataSet } from './worktree-metadata-set-patch'
import { listingMetadataCoverage, noteWorkspaceMetadataRecord } from './workspace-metadata-coverage'
import type { AdmittedDetectedWorktreeRefresh } from './worktree-slice-types'

const ID = 'repo-1::/work/orca'
const issue = (title?: string): WorkspaceAttachment[] => [
  { provider: 'github', type: 'issue', number: 42, ...(title ? { title } : {}) }
]
const local = { kind: 'local' as const }

function state(linkedItems: WorkspaceAttachment[] = issue()): AppState {
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

function record(seq: number, epoch: string, hostId: 'local' | 'ssh:build-box' = 'ssh:build-box') {
  return {
    kind: 'set' as const,
    domain: 'workspaceMetadata' as const,
    hostId,
    epoch,
    seq,
    id: `${hostId}::${ID}`,
    repoId: 'repo-1',
    worktreeId: ID,
    row: {
      linkedItems: issue('Fix login'),
      linkedWorkItem: null,
      linkedIssue: 42,
      linkedTaskSourceContext: null
    }
  }
}

const linksOn = (value: AppState, hostId: string) =>
  selectWorktreesByRepo(value)['repo-1'].find((row) => row.hostId === hostId)?.linkedItems

describe('addressed workspace metadata records', () => {
  it('title only the named host row, and never bring back an unlinked issue', () => {
    const { patch, applied } = patchWorktreeMetadataSet(state(), record(1, 'e1'), local)
    const titled = { ...state(), ...patch }
    expect(applied).toBe(true)
    expect(linksOn(titled, 'ssh:build-box')).toEqual(issue('Fix login'))
    expect(linksOn(titled, 'local')).toEqual(issue())

    expect(patchWorktreeMetadataSet(state([]), record(2, 'e1'), local)).toEqual({
      patch: null,
      applied: false
    })

    // A second titled link the row doesn't list yet still needs a listing.
    const twoLinks = record(3, 'e1')
    twoLinks.row.linkedItems = [
      ...issue('Fix login'),
      { provider: 'github', type: 'issue', number: 43, title: 'Fix logout' }
    ]
    expect(patchWorktreeMetadataSet(state(), twoLinks, local).applied).toBe(false)
  })

  it('keeps a shown title through a listing that predates it, then lists the repo afresh', async () => {
    noteWorkspaceMetadataRecord('local', 'e2', 7, 'repo-1', 'local', () => true)
    const shown = {
      ...state(),
      ...patchWorktreeMetadataSet(state(), record(7, 'e2', 'local'), local).patch
    }
    const listing = (seq: number): AdmittedDetectedWorktreeRefresh => ({
      status: 'admitted',
      executionHostId: 'local',
      result: {
        repoId: 'repo-1',
        authoritative: true,
        source: 'git',
        workspaceMetadata: { epoch: 'e2', seq },
        worktrees: [
          {
            ...makeWorktree(ID, 'local orca', { linkedIssue: 42, linkedItems: issue() }),
            ownership: 'orca-managed',
            selectedCheckout: false,
            visible: true
          }
        ]
      }
    })
    const fetchWorktrees = vi.fn(async () => true)

    const stale = listingMetadataCoverage(shown, 'repo-1', 'local', listing(6))
    expect(stale.refresh.result.worktrees[0].linkedItems).toEqual(issue('Fix login'))
    stale.settle(fetchWorktrees)
    expect(fetchWorktrees).toHaveBeenCalledWith('repo-1', {
      forceLocalOwner: true,
      forceFresh: true,
      suppressRemoteLineageRefresh: true
    })

    const covering = listingMetadataCoverage(shown, 'repo-1', 'local', listing(7))
    expect(covering.refresh.result.worktrees[0].linkedItems).toEqual(issue())
    covering.settle(fetchWorktrees)
    expect(fetchWorktrees).toHaveBeenCalledTimes(1)
    // A listing that read before record 7 and lands after the covering one still keeps the title, and
    // lists again for anything else it dropped.
    const late = listingMetadataCoverage(shown, 'repo-1', 'local', listing(6))
    expect(late.refresh.result.worktrees[0].linkedItems).toEqual(issue('Fix login'))
    late.settle(fetchWorktrees)
    await vi.waitFor(() => expect(fetchWorktrees).toHaveBeenCalledTimes(2))
  })
})
