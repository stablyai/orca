import { describe, expect, it } from 'vitest'
import { MOBILE_WEB_BRIDGE_OPERATIONS } from './bridge-contract'
import {
  MOBILE_WEB_TERMINAL_MAX_INPUT_BYTES,
  MOBILE_WEB_TERMINAL_MAX_OSC_LINKS,
  MOBILE_WEB_TERMINAL_MAX_OSC_LINK_ROW,
  MOBILE_WEB_TERMINAL_MAX_OSC_LINK_URI_CHARACTERS,
  MOBILE_WEB_TERMINAL_MAX_OSC_LINK_URI_LENGTH,
  MOBILE_WEB_TERMINAL_MAX_OUTSTANDING_BYTES,
  MOBILE_WEB_TERMINAL_MAX_OUTPUT_BATCH_BYTES,
  MOBILE_WEB_TERMINAL_MAX_SNAPSHOT_BYTES,
  MOBILE_WEB_TERMINAL_SNAPSHOT_CHUNK_BYTES,
  MobileWebTerminalEventSchema,
  MobileWebTerminalOscLinksSchema,
  MobileWebTerminalOutputEventSchema,
  MobileWebTerminalRequestSchema,
  MobileWebTerminalSnapshotChunkEventSchema,
  canSendMobileWebTerminalOutput,
  validateMobileWebTerminalOutputSequence,
  validateMobileWebTerminalSnapshotOffset
} from './terminal-stream-contract'

const STREAM_ID = 'S'.repeat(22)
const SNAPSHOT_ID = 'N'.repeat(22)
const HASH = 'a'.repeat(64)

function base64Bytes(length: number): string {
  return Buffer.alloc(length, 0x61).toString('base64')
}

function output(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'output',
    streamId: STREAM_ID,
    startSequence: 10,
    endSequence: 13,
    data: base64Bytes(3),
    ...overrides
  }
}

describe('mobile web terminal request contract', () => {
  it('defines every negotiated terminal operation with a concrete request schema', () => {
    const requests = [
      {
        operation: 'subscribe',
        workspaceId: 'worktree-1',
        tabId: 'tab-1',
        viewport: { cols: 80, rows: 24 },
        visible: true
      },
      { operation: 'input', streamId: STREAM_ID, sequence: 1, data: base64Bytes(1) },
      { operation: 'queryReply', streamId: STREAM_ID, sequence: 2, data: base64Bytes(1) },
      {
        operation: 'clipboardPaste',
        streamId: STREAM_ID,
        sequence: 3,
        bracketedPaste: true
      },
      { operation: 'attachImage', streamId: STREAM_ID, sequence: 4, source: 'library' },
      { operation: 'resize', streamId: STREAM_ID, viewport: { cols: 100, rows: 30 } },
      { operation: 'visibility', streamId: STREAM_ID, visible: false },
      {
        operation: 'displayMode',
        streamId: STREAM_ID,
        mode: 'auto',
        viewport: { cols: 100, rows: 30 }
      },
      { operation: 'clear', streamId: STREAM_ID },
      { operation: 'rename', streamId: STREAM_ID, title: 'Build' },
      { operation: 'resync', streamId: STREAM_ID, fromSequence: 3, reason: 'gap' },
      { operation: 'ack', streamId: STREAM_ID, throughSequence: 4 },
      { operation: 'cancel', streamId: STREAM_ID }
    ]

    expect(
      requests.every((request) => MobileWebTerminalRequestSchema.safeParse(request).success)
    ).toBe(true)
    expect(requests.map((request) => request.operation)).toEqual(
      Object.keys(MOBILE_WEB_BRIDGE_OPERATIONS.terminal)
    )
  })

  it('rejects unknown fields, operations, invalid viewport, and oversized input', () => {
    expect(
      MobileWebTerminalRequestSchema.safeParse({
        operation: 'input',
        streamId: STREAM_ID,
        sequence: 1,
        data: base64Bytes(1),
        rawText: 'secret'
      }).success
    ).toBe(false)
    expect(
      MobileWebTerminalRequestSchema.safeParse({ operation: 'write', streamId: STREAM_ID }).success
    ).toBe(false)
    expect(
      MobileWebTerminalRequestSchema.safeParse({
        operation: 'resize',
        streamId: STREAM_ID,
        viewport: { cols: 1, rows: 24 }
      }).success
    ).toBe(false)
    expect(
      MobileWebTerminalRequestSchema.safeParse({
        operation: 'input',
        streamId: STREAM_ID,
        sequence: 1,
        data: base64Bytes(MOBILE_WEB_TERMINAL_MAX_INPUT_BYTES + 1)
      }).success
    ).toBe(false)
    expect(
      MobileWebTerminalRequestSchema.safeParse({
        operation: 'rename',
        streamId: STREAM_ID,
        title: 'x'.repeat(201)
      }).success
    ).toBe(false)
  })
})

describe('mobile web terminal output contract', () => {
  it('accepts a byte-bounded batch whose sequence span matches decoded bytes', () => {
    expect(MobileWebTerminalOutputEventSchema.safeParse(output()).success).toBe(true)
    expect(
      MobileWebTerminalOutputEventSchema.safeParse(
        output({
          startSequence: 0,
          endSequence: MOBILE_WEB_TERMINAL_MAX_OUTPUT_BATCH_BYTES,
          data: base64Bytes(MOBILE_WEB_TERMINAL_MAX_OUTPUT_BATCH_BYTES)
        })
      ).success
    ).toBe(true)
  })

  it('rejects invalid base64, oversized batches, and sequence-length mismatch', () => {
    expect(MobileWebTerminalOutputEventSchema.safeParse(output({ data: '***=' })).success).toBe(
      false
    )
    expect(
      MobileWebTerminalOutputEventSchema.safeParse(
        output({ data: base64Bytes(MOBILE_WEB_TERMINAL_MAX_OUTPUT_BATCH_BYTES + 1) })
      ).success
    ).toBe(false)
    expect(MobileWebTerminalOutputEventSchema.safeParse(output({ endSequence: 14 })).success).toBe(
      false
    )
    expect(
      MobileWebTerminalRequestSchema.safeParse({
        operation: 'input',
        streamId: STREAM_ID,
        sequence: 1,
        data: `${base64Bytes(1)}\n`
      }).success
    ).toBe(false)
    expect(
      MobileWebTerminalRequestSchema.safeParse({
        operation: 'input',
        streamId: `${STREAM_ID}\n`,
        sequence: 1,
        data: base64Bytes(1)
      }).success
    ).toBe(false)
  })

  it('detects duplicate and missing byte ranges instead of skipping them', () => {
    const event = MobileWebTerminalOutputEventSchema.parse(output())
    expect(validateMobileWebTerminalOutputSequence(10, event)).toEqual({
      ok: true,
      nextSequence: 13
    })
    expect(validateMobileWebTerminalOutputSequence(11, event)).toEqual({
      ok: false,
      reason: 'duplicate'
    })
    expect(validateMobileWebTerminalOutputSequence(9, event)).toEqual({
      ok: false,
      reason: 'gap'
    })
  })

  it('enforces the hard outstanding-byte window before sending another batch', () => {
    expect(canSendMobileWebTerminalOutput(0, 0, 1)).toBe(true)
    expect(
      canSendMobileWebTerminalOutput(
        0,
        MOBILE_WEB_TERMINAL_MAX_OUTSTANDING_BYTES - MOBILE_WEB_TERMINAL_MAX_OUTPUT_BATCH_BYTES,
        MOBILE_WEB_TERMINAL_MAX_OUTPUT_BATCH_BYTES
      )
    ).toBe(true)
    expect(canSendMobileWebTerminalOutput(0, MOBILE_WEB_TERMINAL_MAX_OUTSTANDING_BYTES, 1)).toBe(
      false
    )
  })
})

describe('mobile web terminal snapshot and lifecycle contract', () => {
  it('accepts bounded snapshot start, chunk, end, metadata, resize, close, and error events', () => {
    const events = [
      {
        type: 'snapshotStart',
        streamId: STREAM_ID,
        snapshotId: SNAPSHOT_ID,
        kind: 'initial',
        viewport: { cols: 80, rows: 24 },
        totalBytes: 3,
        throughSequence: 10,
        sha256: HASH,
        truncated: false,
        source: 'host-model',
        oscLinks: [{ row: 0, startCol: 2, endCol: 5, uri: 'file:///tmp/a.ts' }]
      },
      {
        type: 'snapshotChunk',
        streamId: STREAM_ID,
        snapshotId: SNAPSHOT_ID,
        offset: 0,
        data: base64Bytes(3)
      },
      {
        type: 'snapshotEnd',
        streamId: STREAM_ID,
        snapshotId: SNAPSHOT_ID,
        totalBytes: 3,
        throughSequence: 10,
        sha256: HASH
      },
      { type: 'resized', streamId: STREAM_ID, viewport: { cols: 90, rows: 30 } },
      {
        type: 'metadata',
        streamId: STREAM_ID,
        displayMode: 'auto'
      },
      { type: 'closed', streamId: STREAM_ID, reason: 'terminal-exited' },
      { type: 'error', streamId: STREAM_ID, code: 'host_error', recoverable: true }
    ]
    expect(events.every((event) => MobileWebTerminalEventSchema.safeParse(event).success)).toBe(
      true
    )
  })

  it('rejects snapshots and chunks above their byte limits', () => {
    expect(
      MobileWebTerminalEventSchema.safeParse({
        type: 'snapshotStart',
        streamId: STREAM_ID,
        snapshotId: SNAPSHOT_ID,
        kind: 'resync',
        viewport: { cols: 80, rows: 24 },
        totalBytes: MOBILE_WEB_TERMINAL_MAX_SNAPSHOT_BYTES + 1,
        throughSequence: 10,
        sha256: HASH,
        truncated: false,
        source: 'host-model'
      }).success
    ).toBe(false)
    expect(
      MobileWebTerminalSnapshotChunkEventSchema.safeParse({
        type: 'snapshotChunk',
        streamId: STREAM_ID,
        snapshotId: SNAPSHOT_ID,
        offset: 0,
        data: base64Bytes(MOBILE_WEB_TERMINAL_SNAPSHOT_CHUNK_BYTES + 1)
      }).success
    ).toBe(false)
  })

  it('bounds OSC link count, coordinates, URI length, aggregate size, and shape', () => {
    const link = { row: 0, startCol: 2, endCol: 5, uri: 'file:///tmp/a.ts' }
    expect(MobileWebTerminalOscLinksSchema.safeParse([link]).success).toBe(true)
    expect(
      MobileWebTerminalOscLinksSchema.safeParse(
        Array.from({ length: MOBILE_WEB_TERMINAL_MAX_OSC_LINKS + 1 }, () => link)
      ).success
    ).toBe(false)
    for (const invalid of [
      { ...link, row: MOBILE_WEB_TERMINAL_MAX_OSC_LINK_ROW + 1 },
      { ...link, startCol: 5, endCol: 5 },
      { ...link, endCol: 1_001 },
      { ...link, uri: 'x'.repeat(MOBILE_WEB_TERMINAL_MAX_OSC_LINK_URI_LENGTH + 1) },
      { ...link, rawPath: '/secret' }
    ]) {
      expect(MobileWebTerminalOscLinksSchema.safeParse([invalid]).success).toBe(false)
    }
    const aggregateCount =
      Math.floor(
        MOBILE_WEB_TERMINAL_MAX_OSC_LINK_URI_CHARACTERS /
          MOBILE_WEB_TERMINAL_MAX_OSC_LINK_URI_LENGTH
      ) + 1
    expect(
      MobileWebTerminalOscLinksSchema.safeParse(
        Array.from({ length: aggregateCount }, () => ({
          ...link,
          uri: 'x'.repeat(MOBILE_WEB_TERMINAL_MAX_OSC_LINK_URI_LENGTH)
        }))
      ).success
    ).toBe(false)
  })

  it('detects duplicate and missing snapshot chunk offsets', () => {
    const chunk = MobileWebTerminalSnapshotChunkEventSchema.parse({
      type: 'snapshotChunk',
      streamId: STREAM_ID,
      snapshotId: SNAPSHOT_ID,
      offset: 100,
      data: base64Bytes(3)
    })
    expect(validateMobileWebTerminalSnapshotOffset(100, chunk)).toEqual({
      ok: true,
      nextSequence: 103
    })
    expect(validateMobileWebTerminalSnapshotOffset(101, chunk)).toEqual({
      ok: false,
      reason: 'duplicate'
    })
    expect(validateMobileWebTerminalSnapshotOffset(99, chunk)).toEqual({
      ok: false,
      reason: 'gap'
    })
  })
})
