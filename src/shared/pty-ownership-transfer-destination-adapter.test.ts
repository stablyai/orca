import { describe, expect, it } from 'vitest'
import type {
  PtyOwnershipTransferCommitReceipt,
  PtyOwnershipTransferDestinationJournal,
  PtyOwnershipTransferIdentity,
  PtyOwnershipTransferPublicationReceipt
} from './pty-ownership-transfer-journal-contract'
import {
  PtyOwnershipTransferDestinationAdapter,
  PtyOwnershipTransferDestinationError,
  type PtyOwnershipTransferDestinationStore
} from './pty-ownership-transfer-destination-adapter'
import type {
  PtyOwnershipTransferOutputFrame,
  PtyOwnershipTransferPrepareResult,
  PtyOwnershipTransferReplayResult
} from './pty-ownership-transfer-wire'
import type { PtyOwnershipTransferSurfaceBinding } from './pty-ownership-transfer-surface-binding'

const identity: PtyOwnershipTransferIdentity = {
  bridgeId: 'bridge-1',
  terminalId: 'terminal-1',
  incarnationId: 'incarnation-1',
  ownerLease: 'lease-1',
  sourceOwnerGeneration: 3,
  destinationRuntimeId: 'runtime-bun-1'
}

const surfaceBinding: PtyOwnershipTransferSurfaceBinding = {
  executionHostId: 'local',
  workspaceKey: 'folder:folder-1',
  tabId: 'tab-1',
  leafId: '11111111-1111-4111-8111-111111111111',
  ptyId: 'terminal-1'
}

const prepareResult: PtyOwnershipTransferPrepareResult = {
  ...identity,
  version: 1,
  phase: 'prepared',
  sourceOutputEndSeq: 2,
  replayStartSeq: 1,
  surfacePublication: { version: 1, surfaceBinding }
}

const frames: PtyOwnershipTransferOutputFrame[] = [
  { seq: 1, data: 'first\n' },
  { seq: 2, data: 'second\n' }
]

const commitReceipt: PtyOwnershipTransferCommitReceipt = {
  receiptId: 'receipt-1',
  bridgeId: identity.bridgeId,
  acceptedSourceEndSeq: 2,
  committedAt: '2026-08-30T12:01:00.000Z'
}

function createStore() {
  let journal: PtyOwnershipTransferDestinationJournal | null = null
  const stagedFrames: PtyOwnershipTransferOutputFrame[] = []
  const inputs = new Map<string, string>()
  const calls: string[] = []
  let binding: PtyOwnershipTransferSurfaceBinding | null = null
  let publicationIntent: PtyOwnershipTransferPublicationReceipt | null = null
  const store: PtyOwnershipTransferDestinationStore = {
    load: () => journal,
    prepare: (nextIdentity, acceptedSourceEndSeq) => {
      calls.push('prepare')
      journal = makeJournal(nextIdentity, 'prepared', acceptedSourceEndSeq)
      return journal
    },
    loadFrames: () => stagedFrames,
    appendFrame: (nextIdentity, frame) => {
      calls.push(`append:${frame.seq}`)
      stagedFrames.push(frame)
      journal = makeJournal(nextIdentity, 'prepared', frame.seq)
      return journal
    },
    commit: (nextIdentity, receipt) => {
      calls.push('commit')
      journal = {
        ...makeJournal(nextIdentity, 'committed', receipt.acceptedSourceEndSeq),
        receipt
      }
      return journal
    },
    loadSurfaceBinding: () => binding,
    bindSurface: (_nextIdentity, nextBinding) => {
      calls.push('bind')
      if (binding && JSON.stringify(binding) !== JSON.stringify(nextBinding)) {
        throw new Error('surface-conflict')
      }
      binding = nextBinding
      return binding
    },
    reservePublication: (nextIdentity, receipt) => {
      calls.push('reserve-publication')
      publicationIntent ??= {
        version: 1,
        publicationReceiptId: 'publication-1',
        bridgeId: nextIdentity.bridgeId,
        destinationRuntimeId: nextIdentity.destinationRuntimeId,
        commitReceipt: receipt,
        publishedAt: '2026-08-30T12:02:00.000Z',
        surfaceBinding: binding ?? undefined
      }
      return publicationIntent
    },
    publish: (nextIdentity, publicationReceipt) => {
      calls.push('publish')
      journal = {
        ...makeJournal(
          nextIdentity,
          'published',
          publicationReceipt.commitReceipt.acceptedSourceEndSeq
        ),
        receipt: publicationReceipt.commitReceipt,
        publicationReceipt
      }
      return journal
    },
    abort: (nextIdentity) => {
      calls.push('abort')
      journal = makeJournal(nextIdentity, 'aborted', 0)
      return journal
    },
    loadInputIds: () => [...inputs].map(([inputId, data]) => ({ inputId, data })),
    acceptInput: (_nextIdentity, inputId, data) => {
      const previous = inputs.get(inputId)
      if (previous !== undefined) {
        return previous === data ? 'duplicate' : 'conflict'
      }
      inputs.set(inputId, data)
      return 'accepted'
    },
    retireInput: (_nextIdentity, inputIds) => {
      let retired = 0
      for (const inputId of inputIds) {
        if (inputs.delete(inputId)) {
          retired++
        }
      }
      return retired
    }
  }
  return { store, calls, getJournal: () => journal }
}

function makeJournal(
  nextIdentity: PtyOwnershipTransferIdentity,
  phase: PtyOwnershipTransferDestinationJournal['phase'],
  acceptedSourceEndSeq: number
): PtyOwnershipTransferDestinationJournal {
  const now = '2026-08-30T12:00:00.000Z'
  return {
    ...nextIdentity,
    version: 1,
    side: 'destination',
    phase,
    acceptedSourceEndSeq,
    startedAt: now,
    updatedAt: now
  }
}

function createAdapter(
  store: PtyOwnershipTransferDestinationStore,
  published: PtyOwnershipTransferOutputFrame[] = [],
  inputIds = 32
) {
  return new PtyOwnershipTransferDestinationAdapter({
    store,
    inputIds,
    publishDurably: (request) => {
      published.push(...request.frames)
      return request.publicationReceipt
    },
    publishPostCommitOutput: () => {}
  })
}

describe('PtyOwnershipTransferDestinationAdapter', () => {
  it('durably stages replay, commits, publishes, and recovers idempotently', () => {
    const { store, calls } = createStore()
    const published: PtyOwnershipTransferOutputFrame[] = []
    const adapter = createAdapter(store, published)
    adapter.prepare(prepareResult)
    const replay: PtyOwnershipTransferReplayResult = {
      ...prepareResult,
      frames,
      sourceOutputEndSeq: 2
    }
    adapter.acceptReplay(replay)
    adapter.bindSurface(surfaceBinding)
    expect(adapter.snapshot()).toMatchObject({
      phase: 'prepared',
      acceptedSourceEndSeq: 2,
      stagedOutputFrames: 2,
      stagedOutputBytes: 13
    })
    adapter.commit(commitReceipt)
    const publication = adapter.publish()
    expect(publication.publicationReceiptId).toBe('publication-1')
    expect(published).toEqual(frames)
    expect(calls).toEqual([
      'prepare',
      'append:1',
      'append:2',
      'bind',
      'commit',
      'reserve-publication',
      'publish'
    ])

    const recoveredPublished: PtyOwnershipTransferOutputFrame[] = []
    const recovered = createAdapter(store, recoveredPublished)
    recovered.prepare(prepareResult)
    expect(recovered.commit(commitReceipt).phase).toBe('published')
    expect(recovered.publish()).toEqual(publication)
    expect(recoveredPublished).toEqual([])
  })

  it('rejects gaps and changed duplicates before durable advancement', () => {
    const { store } = createStore()
    const adapter = createAdapter(store)
    adapter.prepare(prepareResult)
    expect(() => adapter.acceptReplayFrame({ seq: 2, data: 'second\n' })).toThrow(
      expect.objectContaining({ reason: 'output-gap' })
    )
    adapter.acceptReplayFrame(frames[0]!)
    expect(() => adapter.acceptReplayFrame({ seq: 1, data: 'changed\n' })).toThrow(
      expect.objectContaining({ reason: 'output-conflict' })
    )
    expect(adapter.snapshot().acceptedSourceEndSeq).toBe(1)
  })

  it('rejects explicitly truncated replay before durable advancement', () => {
    const { store } = createStore()
    const adapter = createAdapter(store)
    adapter.prepare(prepareResult)

    expect(() =>
      adapter.acceptReplayFrame({ seq: 1, data: 'partial output', truncated: true })
    ).toThrow(expect.objectContaining({ reason: 'output-conflict' }))
    expect(adapter.snapshot().acceptedSourceEndSeq).toBe(0)
  })

  it('keeps post-commit output contiguous and deduplicates durable input', () => {
    const { store } = createStore()
    const postCommit: PtyOwnershipTransferOutputFrame[] = []
    const adapter = new PtyOwnershipTransferDestinationAdapter({
      store,
      publishDurably: (request) => request.publicationReceipt,
      publishPostCommitOutput: (_nextIdentity, _surfaceBinding, frame) => postCommit.push(frame),
      inputIds: 1
    })
    adapter.prepare(prepareResult)
    adapter.acceptReplay({ ...prepareResult, frames, sourceOutputEndSeq: 2 })
    adapter.bindSurface(surfaceBinding)
    adapter.commit(commitReceipt)
    adapter.acceptPostCommitOutput({ seq: 3, data: 'third\n' })
    expect(() => adapter.acceptPostCommitOutput({ seq: 5, data: 'gap\n' })).toThrow(
      expect.objectContaining({ reason: 'output-gap' })
    )
    expect(adapter.acceptInput('input-1', 'ls\n')).toEqual({ accepted: true, duplicate: false })
    expect(adapter.acceptInput('input-1', 'ls\n')).toEqual({ accepted: false, duplicate: true })
    expect(() => adapter.acceptInput('input-2', 'blocked')).toThrow(
      expect.objectContaining({ reason: 'input-deduplication-window-exhausted' })
    )
    expect(() => adapter.acceptInput('input-1', 'whoami\n')).toThrow(
      expect.objectContaining({ reason: 'input-conflict' })
    )
    expect(adapter.retireInput(['input-1'])).toBe(1)
    expect(postCommit).toEqual([{ seq: 3, data: 'third\n' }])
  })

  it('aborts a prepared transfer and refuses reuse of the durable tombstone', () => {
    const { store } = createStore()
    const adapter = createAdapter(store)
    adapter.prepare(prepareResult)
    adapter.acceptReplayFrame(frames[0]!)
    expect(adapter.abort().phase).toBe('aborted')
    expect(() => adapter.prepare(prepareResult)).toThrow(
      expect.objectContaining({ reason: 'invalid-phase' })
    )
  })

  it('rejects an identity change during recovery', () => {
    const { store } = createStore()
    const adapter = createAdapter(store)
    adapter.prepare(prepareResult)
    expect(() =>
      adapter.acceptReplay({
        ...prepareResult,
        ownerLease: 'other-lease',
        frames,
        sourceOutputEndSeq: 2
      })
    ).toThrow(PtyOwnershipTransferDestinationError)
  })

  it('accepts only the newest in-process attachment generation', () => {
    const { store } = createStore()
    const adapter = createAdapter(store)
    adapter.prepare(prepareResult)
    const stale = adapter.reserveExecutionAttachment('attachment-stale')
    const current = adapter.reserveExecutionAttachment('attachment-current')

    expect(() =>
      adapter.attachExecution(
        {
          ...identity,
          version: 1,
          phase: 'prepared',
          attachmentId: stale.attachmentId,
          executionVerdict: 'live'
        },
        stale
      )
    ).toThrow(expect.objectContaining({ reason: 'stale-attachment' }))
    expect(
      adapter.attachExecution(
        {
          ...identity,
          version: 1,
          phase: 'prepared',
          attachmentId: current.attachmentId,
          executionVerdict: 'live'
        },
        current
      )
    ).toMatchObject({
      attachmentId: 'attachment-current',
      attachmentGeneration: 2,
      executionVerdict: 'live'
    })
  })

  it('rejects a pre-restart reservation at the recovered destination', () => {
    const { store } = createStore()
    const first = createAdapter(store)
    first.prepare(prepareResult)
    first.acceptReplay({ ...prepareResult, frames, sourceOutputEndSeq: 2 })
    first.bindSurface(surfaceBinding)
    first.commit(commitReceipt)
    const stale = first.reserveExecutionAttachment('attachment-reused')

    const recovered = createAdapter(store)
    recovered.prepare(prepareResult)
    const current = recovered.reserveExecutionAttachment('attachment-reused')
    const result = {
      ...identity,
      version: 1 as const,
      phase: 'committed' as const,
      attachmentId: 'attachment-reused',
      executionVerdict: 'live' as const
    }

    expect(() => recovered.attachExecution(result, stale)).toThrow(
      expect.objectContaining({ reason: 'stale-attachment' })
    )
    expect(recovered.attachExecution(result, current)).toMatchObject({
      attachmentGeneration: 1,
      executionVerdict: 'live'
    })
  })

  it('requires one exact durable surface binding before publication', () => {
    const { store } = createStore()
    const adapter = createAdapter(store)
    adapter.prepare(prepareResult)
    adapter.acceptReplay({ ...prepareResult, frames, sourceOutputEndSeq: 2 })
    adapter.commit(commitReceipt)
    expect(() => adapter.publish()).toThrow(expect.objectContaining({ reason: 'surface-unbound' }))
    expect(adapter.bindSurface(surfaceBinding).surfaceBinding).toEqual(surfaceBinding)
    expect(() =>
      adapter.bindSurface({ ...surfaceBinding, workspaceKey: 'worktree:repo-1::/workspace' })
    ).toThrow(expect.objectContaining({ reason: 'surface-conflict' }))
    expect(adapter.publish().surfaceBinding).toEqual(surfaceBinding)
  })

  it('keeps a legacy prepare parseable but outside the safe publication path', () => {
    const { store } = createStore()
    const adapter = createAdapter(store)
    const legacyPrepare = { ...prepareResult, surfacePublication: undefined }
    adapter.prepare(legacyPrepare)
    adapter.acceptReplay({ ...legacyPrepare, frames, sourceOutputEndSeq: 2 })
    adapter.commit(commitReceipt)

    expect(() => adapter.bindSurface(surfaceBinding)).toThrow(
      expect.objectContaining({ reason: 'surface-unbound' })
    )
    expect(() => adapter.publish()).toThrow(expect.objectContaining({ reason: 'surface-unbound' }))
  })
})
