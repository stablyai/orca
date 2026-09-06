import { z } from 'zod'
import { MobileWebBridgeErrorCodeSchema } from './bridge-contract'
import {
  isMobileWebBase64,
  isMobileWebBase64UrlIdentifier,
  isMobileWebSha256
} from './protocol-token-contract'
import { MobileWebTerminalOscLinksSchema } from './terminal-osc-link-contract'

export * from './terminal-osc-link-contract'

export const MOBILE_WEB_TERMINAL_MAX_INPUT_BYTES = 16 * 1024
export const MOBILE_WEB_TERMINAL_MAX_OUTPUT_BATCH_BYTES = 64 * 1024
export const MOBILE_WEB_TERMINAL_SNAPSHOT_CHUNK_BYTES = 48 * 1024
export const MOBILE_WEB_TERMINAL_MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024
export const MOBILE_WEB_TERMINAL_MAX_OUTSTANDING_BYTES = 256 * 1024

const StreamIdSchema = z.string().refine((value) => isMobileWebBase64UrlIdentifier(value, 22))
const SequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const WorkspaceIdSchema = z.string().min(1).max(512)
const TabIdSchema = z.string().min(1).max(512)
const SnapshotIdSchema = z.string().refine((value) => isMobileWebBase64UrlIdentifier(value, 22))
const ViewportSchema = z
  .object({
    cols: z.number().int().min(2).max(1_000),
    rows: z.number().int().min(1).max(1_000)
  })
  .strict()

const InputDataSchema = boundedBase64Schema(MOBILE_WEB_TERMINAL_MAX_INPUT_BYTES)
const OutputDataSchema = boundedBase64Schema(MOBILE_WEB_TERMINAL_MAX_OUTPUT_BATCH_BYTES)
const SnapshotDataSchema = boundedBase64Schema(MOBILE_WEB_TERMINAL_SNAPSHOT_CHUNK_BYTES)

const SubscribeRequestSchema = z
  .object({
    operation: z.literal('subscribe'),
    workspaceId: WorkspaceIdSchema,
    tabId: TabIdSchema,
    viewport: ViewportSchema,
    visible: z.boolean(),
    leaseOnly: z.literal(true).optional()
  })
  .strict()

const SequencedInputShape = {
  streamId: StreamIdSchema,
  sequence: SequenceSchema,
  data: InputDataSchema
} as const

const InputRequestSchema = z
  .object({ operation: z.literal('input'), ...SequencedInputShape })
  .strict()
const QueryReplyRequestSchema = z
  .object({ operation: z.literal('queryReply'), ...SequencedInputShape })
  .strict()
const ClipboardPasteRequestSchema = z
  .object({
    operation: z.literal('clipboardPaste'),
    streamId: StreamIdSchema,
    sequence: SequenceSchema,
    bracketedPaste: z.boolean()
  })
  .strict()
const AttachImageRequestSchema = z
  .object({
    operation: z.literal('attachImage'),
    streamId: StreamIdSchema,
    sequence: SequenceSchema,
    source: z.enum(['library', 'files'])
  })
  .strict()
const ResizeRequestSchema = z
  .object({ operation: z.literal('resize'), streamId: StreamIdSchema, viewport: ViewportSchema })
  .strict()
const VisibilityRequestSchema = z
  .object({ operation: z.literal('visibility'), streamId: StreamIdSchema, visible: z.boolean() })
  .strict()
const DisplayModeRequestSchema = z
  .object({
    operation: z.literal('displayMode'),
    streamId: StreamIdSchema,
    mode: z.enum(['auto', 'desktop']),
    viewport: ViewportSchema.optional()
  })
  .strict()
const ClearRequestSchema = z
  .object({ operation: z.literal('clear'), streamId: StreamIdSchema })
  .strict()
const RenameRequestSchema = z
  .object({
    operation: z.literal('rename'),
    streamId: StreamIdSchema,
    title: z.string().max(200)
  })
  .strict()
const ResyncRequestSchema = z
  .object({
    operation: z.literal('resync'),
    streamId: StreamIdSchema,
    fromSequence: SequenceSchema,
    reason: z.enum(['gap', 'overflow', 'foreground', 'reconnect', 'webview-restored'])
  })
  .strict()
const AckRequestSchema = z
  .object({
    operation: z.literal('ack'),
    streamId: StreamIdSchema,
    throughSequence: SequenceSchema
  })
  .strict()
const CancelRequestSchema = z
  .object({ operation: z.literal('cancel'), streamId: StreamIdSchema })
  .strict()

export const MobileWebTerminalRequestSchema = z.discriminatedUnion('operation', [
  SubscribeRequestSchema,
  InputRequestSchema,
  QueryReplyRequestSchema,
  ClipboardPasteRequestSchema,
  AttachImageRequestSchema,
  ResizeRequestSchema,
  VisibilityRequestSchema,
  DisplayModeRequestSchema,
  ClearRequestSchema,
  RenameRequestSchema,
  ResyncRequestSchema,
  AckRequestSchema,
  CancelRequestSchema
])

export const MobileWebTerminalDeviceInputResultSchema = z
  .object({
    status: z.enum(['accepted', 'empty', 'cancelled', 'permission-denied', 'too-large'])
  })
  .strict()

const SubscribedEventSchema = z
  .object({
    type: z.literal('subscribed'),
    streamId: StreamIdSchema,
    viewport: ViewportSchema,
    startSequence: SequenceSchema,
    maxOutstandingBytes: z.literal(MOBILE_WEB_TERMINAL_MAX_OUTSTANDING_BYTES),
    // Whether the host negotiated opcode 18 on this stream, not an election verdict: the host
    // re-checks reply authority per frame and never publishes it. Absent means a shell that
    // predates the field, which cannot prove negotiation, so the page must not attempt a reply.
    queryReplyNegotiated: z.boolean().optional()
  })
  .strict()

export const MobileWebTerminalOutputEventSchema = z
  .object({
    type: z.literal('output'),
    streamId: StreamIdSchema,
    startSequence: SequenceSchema,
    endSequence: SequenceSchema,
    data: OutputDataSchema
  })
  .strict()
  .superRefine((event, context) => {
    if (event.endSequence <= event.startSequence) {
      context.addIssue({ code: 'custom', message: 'Output sequence must advance' })
      return
    }
    if (decodedBase64Length(event.data) !== event.endSequence - event.startSequence) {
      context.addIssue({ code: 'custom', message: 'Output byte length must match sequence span' })
    }
  })

const SnapshotStartEventSchema = z
  .object({
    type: z.literal('snapshotStart'),
    streamId: StreamIdSchema,
    snapshotId: SnapshotIdSchema,
    kind: z.enum(['initial', 'resize', 'resync']),
    viewport: ViewportSchema,
    totalBytes: z.number().int().nonnegative().max(MOBILE_WEB_TERMINAL_MAX_SNAPSHOT_BYTES),
    throughSequence: SequenceSchema,
    sha256: z.string().refine(isMobileWebSha256),
    truncated: z.boolean(),
    source: z.enum(['host-model', 'renderer']),
    oscLinks: MobileWebTerminalOscLinksSchema.optional()
  })
  .strict()

export const MobileWebTerminalSnapshotChunkEventSchema = z
  .object({
    type: z.literal('snapshotChunk'),
    streamId: StreamIdSchema,
    snapshotId: SnapshotIdSchema,
    offset: z.number().int().nonnegative().max(MOBILE_WEB_TERMINAL_MAX_SNAPSHOT_BYTES),
    data: SnapshotDataSchema
  })
  .strict()
  .superRefine((event, context) => {
    if (event.offset + decodedBase64Length(event.data) > MOBILE_WEB_TERMINAL_MAX_SNAPSHOT_BYTES) {
      context.addIssue({ code: 'custom', message: 'Snapshot chunk exceeds snapshot bound' })
    }
  })

const SnapshotEndEventSchema = z
  .object({
    type: z.literal('snapshotEnd'),
    streamId: StreamIdSchema,
    snapshotId: SnapshotIdSchema,
    totalBytes: z.number().int().nonnegative().max(MOBILE_WEB_TERMINAL_MAX_SNAPSHOT_BYTES),
    throughSequence: SequenceSchema,
    sha256: z.string().refine(isMobileWebSha256)
  })
  .strict()

const ResizedEventSchema = z
  .object({ type: z.literal('resized'), streamId: StreamIdSchema, viewport: ViewportSchema })
  .strict()
const MetadataEventSchema = z
  .object({
    type: z.literal('metadata'),
    streamId: StreamIdSchema,
    displayMode: z.enum(['auto', 'desktop'])
  })
  .strict()
const ClosedEventSchema = z
  .object({
    type: z.literal('closed'),
    streamId: StreamIdSchema,
    reason: z.enum(['terminal-exited', 'cancelled', 'disconnected', 'session-expired'])
  })
  .strict()
const ErrorEventSchema = z
  .object({
    type: z.literal('error'),
    streamId: StreamIdSchema,
    code: MobileWebBridgeErrorCodeSchema,
    recoverable: z.boolean()
  })
  .strict()

export const MobileWebTerminalEventSchema = z.union([
  SubscribedEventSchema,
  MobileWebTerminalOutputEventSchema,
  SnapshotStartEventSchema,
  MobileWebTerminalSnapshotChunkEventSchema,
  SnapshotEndEventSchema,
  ResizedEventSchema,
  MetadataEventSchema,
  ClosedEventSchema,
  ErrorEventSchema
])

export type MobileWebTerminalRequest = z.infer<typeof MobileWebTerminalRequestSchema>
export type MobileWebTerminalDeviceInputResult = z.infer<
  typeof MobileWebTerminalDeviceInputResultSchema
>
export type MobileWebTerminalEvent = z.infer<typeof MobileWebTerminalEventSchema>
export type MobileWebTerminalOutputEvent = z.infer<typeof MobileWebTerminalOutputEventSchema>

export type MobileWebTerminalSequenceResult =
  | { ok: true; nextSequence: number }
  | { ok: false; reason: 'duplicate' | 'gap' }

export function validateMobileWebTerminalOutputSequence(
  expectedSequence: number,
  event: MobileWebTerminalOutputEvent
): MobileWebTerminalSequenceResult {
  if (event.startSequence < expectedSequence) {
    return { ok: false, reason: 'duplicate' }
  }
  if (event.startSequence > expectedSequence) {
    return { ok: false, reason: 'gap' }
  }
  return { ok: true, nextSequence: event.endSequence }
}

export function validateMobileWebTerminalSnapshotOffset(
  expectedOffset: number,
  event: z.infer<typeof MobileWebTerminalSnapshotChunkEventSchema>
): MobileWebTerminalSequenceResult {
  if (event.offset < expectedOffset) {
    return { ok: false, reason: 'duplicate' }
  }
  if (event.offset > expectedOffset) {
    return { ok: false, reason: 'gap' }
  }
  return { ok: true, nextSequence: event.offset + decodedBase64Length(event.data) }
}

export function canSendMobileWebTerminalOutput(
  acknowledgedSequence: number,
  sentSequence: number,
  nextBytes: number
): boolean {
  return (
    Number.isSafeInteger(acknowledgedSequence) &&
    Number.isSafeInteger(sentSequence) &&
    Number.isSafeInteger(nextBytes) &&
    acknowledgedSequence >= 0 &&
    sentSequence >= acknowledgedSequence &&
    nextBytes > 0 &&
    nextBytes <= MOBILE_WEB_TERMINAL_MAX_OUTPUT_BATCH_BYTES &&
    sentSequence - acknowledgedSequence + nextBytes <= MOBILE_WEB_TERMINAL_MAX_OUTSTANDING_BYTES
  )
}

export function decodedBase64Length(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return (value.length / 4) * 3 - padding
}

function boundedBase64Schema(maxBytes: number): z.ZodType<string> {
  return z
    .string()
    .min(4)
    .refine(isMobileWebBase64)
    .refine((value) => decodedBase64Length(value) <= maxBytes, 'Decoded data exceeds byte limit')
}
