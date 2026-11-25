import type { DiffComment } from '../../../../../shared/file-review/diff-comment-types'
import type { FolderWorkspace } from '../../../../../shared/folder-workspaces/folder-workspace-types'
import {
  applyDiffCommentWrite,
  type DiffCommentBaseMutation
} from '../../../../../shared/file-review/diff-comment-mutation'
import type {
  FolderDiffCommentMergeRequest,
  FolderDiffCommentReceipt
} from '../../../../../shared/file-review/folder-diff-comment-merge'
import { mergeFolderDiffCommentsOnHost } from '../../../../../shared/file-review/folder-diff-comment-merge-operation'
import { makeFolderWorkspace } from '@/components/sidebar/workspace-creation/folder/folder-workspace-composer-submit-fixtures'

export type HostKind = 'local' | 'paired' | 'paired-older'

export type OrdinaryUpdates = { diffComments?: DiffComment[] } & DiffCommentBaseMutation

/** One host's folder row and how it answers each kind of note write. */
export function createModelHost(kind: HostKind, saved: DiffComment[]) {
  const host = {
    row: makeFolderWorkspace({
      id: 'folder-1',
      folderPath: '/workspace',
      ...(kind === 'local' ? { executionHostId: 'local' as const } : {}),
      diffComments: saved,
      createdAt: 7
    }),
    // An older paired server has no merge method and replaces the list on every update.
    supportsMerge: kind !== 'paired-older',
    clock: 1000,
    effects: { ordinary: 0, merges: 0, reads: 0 },
    /** Next ordinary update: 'refuse' never reaches the host; 'drop-ack' lands, reply lost. */
    nextOrdinary: 'ok' as 'ok' | 'refuse' | 'drop-ack',
    /** An ordinary update waits here before it reaches the host. */
    ordinaryGate: undefined as Promise<void> | undefined,
    /** Next merge-method calls, consumed in order. */
    nextMerges: [] as ('ok' | 'drop-ack' | 'refuse')[],
    mergeGate: undefined as Promise<void> | undefined,
    /** A read samples the row first, then waits here before its reply is delivered. */
    readGate: undefined as Promise<void> | undefined,
    /** Next reads, consumed in order: 'fail' never reaches the host. */
    nextReads: [] as ('ok' | 'fail')[],
    requests: [] as FolderDiffCommentMergeRequest[],
    /** Modes for the next ordinary updates, consumed before `nextOrdinary`. */
    nextOrdinaryModes: [] as ('ok' | 'refuse' | 'drop-ack')[],
    /** Paired catalog lists waiting to be answered, each sampled when its fetch started. */
    pairedLists: [] as { gate: Promise<void>; sampled: FolderWorkspace }[],
    ordinary(updates: OrdinaryUpdates): FolderWorkspace {
      const mode = host.nextOrdinaryModes.shift() ?? host.nextOrdinary
      host.nextOrdinary = 'ok'
      if (mode === 'refuse') {
        throw new Error('host unreachable')
      }
      host.effects.ordinary += 1
      host.row = {
        ...host.row,
        updatedAt: host.clock--,
        diffComments:
          kind === 'paired-older'
            ? updates.diffComments
            : applyDiffCommentWrite(host.row.diffComments, updates)
      }
      if (mode === 'drop-ack') {
        throw new Error('connection lost')
      }
      return host.row
    },
    async merge(request: FolderDiffCommentMergeRequest): Promise<FolderDiffCommentReceipt> {
      host.requests.push(request)
      if (request.mode === 'read' && host.nextReads.shift() === 'fail') {
        throw new Error('host unreachable')
      }
      if (request.mode === 'merge') {
        await host.mergeGate
      }
      const mode = request.mode === 'read' ? 'ok' : (host.nextMerges.shift() ?? 'ok')
      const receipt = mergeFolderDiffCommentsOnHost(
        {
          rows: () => [host.row],
          visibleRows: () => [host.row],
          assertWritable: () => {
            if (mode === 'refuse') {
              throw new Error('fenced')
            }
          },
          update: (_id, updates) => {
            host.effects.merges += 1
            host.row = {
              ...host.row,
              updatedAt: host.clock--,
              diffComments: applyDiffCommentWrite(host.row.diffComments, updates)
            }
            return host.row
          },
          notify: () => {}
        },
        request
      )
      if (request.mode === 'read') {
        host.effects.reads += 1
        await host.readGate
      }
      if (mode === 'drop-ack') {
        throw new Error('connection lost')
      }
      return receipt
    },
    /** Another device's save, merged on the host. */
    peer(edit: (notes: DiffComment[]) => DiffComment[]): void {
      const current = host.row.diffComments ?? []
      host.row = {
        ...host.row,
        updatedAt: host.clock--,
        diffComments: applyDiffCommentWrite(current, {
          diffComments: edit(current),
          diffCommentsBase: current
        })
      }
    },
    notes(): string[] {
      return (host.row.diffComments ?? []).map((entry) => `${entry.id}=${entry.body}`)
    }
  }
  return host
}

export type ModelHost = ReturnType<typeof createModelHost>
