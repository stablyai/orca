import { Terminal } from '@xterm/headless'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installTerminalCapabilityReplyHandlers } from '../terminal-capability-replies'
import { bindHiddenOutputRestoreChunk } from './hidden-output-restore-chunk'
import { bindHiddenOutputRestoreDrain } from './hidden-output-restore-drain'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import type { PendingHiddenOutputRestoreChunk } from './pending-hidden-output-restore-chunk'

const terminals: Terminal[] = []
afterEach(() => terminals.splice(0).forEach((terminal) => terminal.dispose()))

function createRestoreSession(isReplaying: () => boolean = () => false) {
  const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
  terminals.push(terminal)
  const replies: string[] = []
  terminal.onData((data) => replies.push(data))
  const capabilityReplies = installTerminalCapabilityReplyHandlers({
    terminal: { cols: 80, rows: 24, element: undefined, options: {} },
    parser: terminal.parser,
    sendInput: (data) => {
      replies.push(data)
    },
    isReplaying
  })
  const writes: string[] = []
  const write = (data: string): void => {
    writes.push(data)
    terminal.write(data)
  }
  const pendingChunks: PendingHiddenOutputRestoreChunk[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these installers only access the supplied restore, transport and output fields.
  const session = {
    pane: { terminal },
    terminalCapabilityRepliesDisposable: capabilityReplies,
    transport: { getPtyId: () => 'remote-pty' },
    transportStreamGeneration: 1,
    hiddenOutputRestorePtyId: 'remote-pty',
    hiddenOutputRestorePendingChunks: pendingChunks,
    hiddenOutputRestorePendingChars: 0,
    hiddenOutputRestorePendingOverflow: false,
    restoredSnapshotBaselinePtyId: 'remote-pty',
    restoredSnapshotBaselineSeq: 100,
    restoredSnapshotDeliveryWindowStartSeq: null,
    restoredSnapshotExpectedStartSeq: 100,
    canUseHiddenOutputSnapshot: () => true,
    armHiddenOutputRestoreForegroundDeadline: vi.fn(),
    writePtyOutputToXterm: write,
    recordRendererOrderedSeq: vi.fn(),
    salvageRendererQueriesFromDiscardedRestoreData: vi.fn()
  } as unknown as ConnectPanePtySession
  bindHiddenOutputRestoreChunk(session)
  bindHiddenOutputRestoreDrain(session)
  return {
    session,
    terminal,
    replies,
    writes,
    write,
    settle: () => new Promise<void>((resolve) => terminal.write(new Uint8Array(0), resolve))
  }
}

describe('snapshot-covered terminal queries', () => {
  it('answers a queued Codex exit DA1 once after preceding terminal reports', async () => {
    const { session, replies, writes, write, settle } = createRestoreSession()
    write('\x1b[?1$p')
    session.queueLiveChunkDuringRestore('old display\x1b[6n\x1b[c', { seq: 100 })
    expect(session.drainPendingLiveChunksAfterSnapshot(100)).toBe('drained')
    await settle()

    expect(replies).toEqual(['\x1b[?1;2$y', '\x1b[?1;2c'])
    expect(writes).toEqual(['\x1b[?1$p'])
    expect(session.hiddenOutputRestorePendingChunks).toHaveLength(0)
  })

  it('answers a split DA1 covered by a snapshot without repainting covered text', async () => {
    const { session, replies, writes, settle } = createRestoreSession()
    session.queueLiveChunkDuringRestore('old display\x1b[', { seq: 99 })
    session.queueLiveChunkDuringRestore('c', { seq: 100 })
    session.drainPendingLiveChunksAfterSnapshot(100)
    await settle()

    expect(replies).toEqual(['\x1b[?1;2c'])
    expect(writes).toEqual([])
  })

  it('answers a live DA1 suppressed by a completed snapshot and preserves newer display bytes', async () => {
    const { session, replies, writes, settle } = createRestoreSession()
    const result = session.reconcileChunkAgainstRestoredSnapshot('old\x1b[cnew', {
      seq: 103,
      rawLength: 9
    })
    expect(result).toEqual({ action: 'write', data: 'new', meta: { seq: 103, rawLength: 3 } })
    session.writePtyOutputToXterm(result.data, true)
    await settle()

    expect(replies).toEqual(['\x1b[?1;2c'])
    expect(writes).toEqual(['new'])
  })

  it('does not reuse a split query from another stream generation', async () => {
    const { session, replies, writes, settle } = createRestoreSession()
    session.reconcileChunkAgainstRestoredSnapshot('\x1b[', { seq: 99 })
    session.transportStreamGeneration += 1
    session.reconcileChunkAgainstRestoredSnapshot('c', { seq: 100 })
    await settle()

    expect(replies).toEqual([])
    expect(writes).toEqual([])
  })

  it('preserves a restored partial SGR while answering the covered exit query', async () => {
    const { session, terminal, replies, write, settle } = createRestoreSession()
    write('\x1b[31')
    session.queueLiveChunkDuringRestore('old\x1b[c\x1b[31', { seq: 100 })
    session.drainPendingLiveChunksAfterSnapshot(100)
    write('mRED')
    await settle()

    expect(replies).toEqual(['\x1b[?1;2c'])
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('RED')
    expect(terminal.buffer.active.getLine(0)?.getCell(0)?.getFgColor()).toBe(1)
  })

  it('does not answer the same covered DA1 again or reply after stream replacement', async () => {
    const { session, replies, settle } = createRestoreSession()
    session.reconcileChunkAgainstRestoredSnapshot('\x1b[c', { seq: 90 })
    session.reconcileChunkAgainstRestoredSnapshot('\x1b[c', { seq: 90 })
    await settle()
    expect(replies).toEqual(['\x1b[?1;2c'])

    session.reconcileChunkAgainstRestoredSnapshot('\x1b[c', { seq: 100 })
    session.transportStreamGeneration += 1
    await settle()
    expect(replies).toEqual(['\x1b[?1;2c'])
  })

  it('answers proven live DA1 even when another snapshot begins before its parse barrier', async () => {
    let replaying = false
    const { session, replies, write, settle } = createRestoreSession(() => replaying)
    session.queueLiveChunkDuringRestore('\x1b[c', { seq: 100 })
    session.drainPendingLiveChunksAfterSnapshot(100)
    replaying = true
    write('\x1b[c')
    await settle()

    expect(replies).toEqual(['\x1b[?1;2c'])
  })
})
