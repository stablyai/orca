import { z } from 'zod'
import {
  MOBILE_WEB_BRIDGE_MAX_GRANTS,
  MOBILE_WEB_BRIDGE_MAX_OPERATION_BYTES,
  MOBILE_WEB_BRIDGE_MAX_PENDING_REQUESTS
} from './bridge-limits'
import { MOBILE_WEB_BRIDGE_PROTOCOL_VERSION } from './bridge-protocol-version'
import { isMobileWebBase64UrlIdentifier, isMobileWebSha256 } from './protocol-token-contract'
import {
  isMobileWebBridgeOperation,
  MobileWebBridgeCapabilitySchema,
  type MobileWebBridgeCapability
} from './bridge-operation-registry'
import {
  parseMobileWebBridgeMessage,
  parseMobileWebBridgeMessageDocument,
  type MobileWebBridgeMessageContext,
  type MobileWebBridgeMessageParseResult
} from './bridge-message-parser'
import { MobileWebNavigationRouteSchema, MobileWebResumeRouteSchema } from './bridge-route-contract'
import {
  MOBILE_WEB_SHELL_MAX_FEATURE_CHARACTERS,
  MOBILE_WEB_SHELL_MAX_FEATURES
} from './shell-feature-contract'
import { tolerantMobileWebShellPayload } from './shell-payload-tolerance'

export {
  isMobileWebBridgeOperation,
  MOBILE_WEB_BRIDGE_OPERATIONS
} from './bridge-operation-registry'
export type {
  MobileWebBridgeCapability,
  MobileWebBridgeOperationName
} from './bridge-operation-registry'
export {
  MOBILE_WEB_BRIDGE_ENVELOPE_RESERVE_BYTES,
  MOBILE_WEB_BRIDGE_MAX_GRANTS,
  MOBILE_WEB_BRIDGE_MAX_MESSAGE_BYTES,
  MOBILE_WEB_BRIDGE_MAX_OPERATION_BYTES,
  MOBILE_WEB_BRIDGE_MAX_PENDING_REQUESTS,
  MOBILE_WEB_BRIDGE_MAX_SUBSCRIPTIONS
} from './bridge-limits'
export { MOBILE_WEB_BRIDGE_PROTOCOL_VERSION } from './bridge-protocol-version'
export {
  MOBILE_WEB_SHELL_FEATURES,
  MOBILE_WEB_SHELL_NATIVE_CHAT_PASTE_FOLLOWED_BY_TEXT_FEATURE
} from './shell-feature-contract'
export type { MobileWebShellFeature } from './shell-feature-contract'
export { MobileWebNavigationRouteSchema, MobileWebResumeRouteSchema } from './bridge-route-contract'
export type { MobileWebNavigationRoute, MobileWebResumeRoute } from './bridge-route-contract'

const MobileWebBridgeOperationShape = {
  capability: MobileWebBridgeCapabilitySchema,
  operation: z.string().min(1).max(40)
} as const

export const MobileWebBridgeErrorCodeSchema = z.enum([
  'invalid_message',
  'too_large',
  'unsupported_version',
  'stale_session',
  'unsupported_capability',
  'invalid_request',
  'rate_limited',
  'permission_required',
  'user_cancelled',
  'not_connected',
  'not_found',
  'conflict',
  'timeout',
  'cancelled',
  'host_error',
  'unavailable',
  'internal'
])

const ShellSessionIdSchema = z.string().refine((value) => isMobileWebBase64UrlIdentifier(value, 43))
const BuildIdSchema = z.string().refine(isMobileWebSha256)
const RequestIdSchema = z.string().refine((value) => isMobileWebBase64UrlIdentifier(value, 22))
const SubscriptionIdSchema = z.string().refine((value) => isMobileWebBase64UrlIdentifier(value, 22))
const SequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

const PageEnvelopeSchema = z.object({
  version: z.literal(MOBILE_WEB_BRIDGE_PROTOCOL_VERSION),
  shellSessionId: ShellSessionIdSchema,
  buildId: BuildIdSchema
})

const PageReadySchema = PageEnvelopeSchema.extend({ type: z.literal('ready') }).strict()

const PageHealthSchema = PageEnvelopeSchema.extend({
  type: z.literal('health'),
  state: z.literal('interactive')
}).strict()

const PageHardwareBackCapabilitySchema = PageEnvelopeSchema.extend({
  type: z.literal('hardwareBackCapability'),
  revision: z.literal(1)
}).strict()

const PageHardwareBackResultSchema = PageEnvelopeSchema.extend({
  type: z.literal('hardwareBackResult'),
  sequence: SequenceSchema,
  handled: z.boolean()
}).strict()

const PageRouteStateSchema = PageEnvelopeSchema.extend({
  type: z.literal('routeState'),
  route: MobileWebResumeRouteSchema
}).strict()

const PageOneShotRequestSchema = PageEnvelopeSchema.extend({
  type: z.literal('request'),
  mode: z.literal('once'),
  requestId: RequestIdSchema,
  capability: MobileWebBridgeCapabilitySchema,
  operation: z.string().min(1).max(40),
  payload: z.unknown()
})
  .strict()
  .superRefine(validateRequestOperation)

const PageSubscriptionRequestSchema = PageEnvelopeSchema.extend({
  type: z.literal('request'),
  mode: z.literal('subscription'),
  requestId: RequestIdSchema,
  subscriptionId: SubscriptionIdSchema,
  capability: MobileWebBridgeCapabilitySchema,
  operation: z.string().min(1).max(40),
  payload: z.unknown()
})
  .strict()
  .superRefine(validateSubscriptionRequest)

const PageCancelSchema = PageEnvelopeSchema.extend({
  type: z.literal('cancel'),
  target: z.enum(['request', 'subscription']),
  id: RequestIdSchema
}).strict()

export const MobileWebBridgePageMessageSchema = z.union([
  PageReadySchema,
  PageHealthSchema,
  PageHardwareBackCapabilitySchema,
  PageHardwareBackResultSchema,
  PageRouteStateSchema,
  PageOneShotRequestSchema,
  PageSubscriptionRequestSchema,
  PageCancelSchema
])

const OperationLimitsSchema = z
  .object({
    maxRequestBytes: z.number().int().positive().max(MOBILE_WEB_BRIDGE_MAX_OPERATION_BYTES),
    maxResponseBytes: z.number().int().positive().max(MOBILE_WEB_BRIDGE_MAX_OPERATION_BYTES),
    maxConcurrent: z.number().int().positive().max(MOBILE_WEB_BRIDGE_MAX_PENDING_REQUESTS),
    rateCapacity: z.number().int().positive().max(1_000),
    rateRefillPerSecond: z.number().positive().max(1_000)
  })
  .strict()

const OperationGrantSchema = z
  .object({ ...MobileWebBridgeOperationShape, limits: OperationLimitsSchema })
  .strict()

const ShellEnvelopeSchema = z.object({
  version: z.literal(MOBILE_WEB_BRIDGE_PROTOCOL_VERSION),
  shellSessionId: ShellSessionIdSchema,
  buildId: BuildIdSchema
})

const ConnectionStateSchema = z.enum(['connecting', 'connected', 'offline', 'recovering'])
const ConnectionMetricsShape = {
  reconnectAttempts: z.number().int().nonnegative().max(1_000_000).optional(),
  lastConnectedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional()
} as const

const ShellInitSchema = ShellEnvelopeSchema.extend({
  type: z.literal('init'),
  connection: ConnectionStateSchema,
  grants: z.array(OperationGrantSchema).max(MOBILE_WEB_BRIDGE_MAX_GRANTS),
  // Absent on a shell built before any feature existed, which reads as "supports none".
  shellFeatures: z
    .array(z.string().min(1).max(MOBILE_WEB_SHELL_MAX_FEATURE_CHARACTERS))
    .max(MOBILE_WEB_SHELL_MAX_FEATURES)
    .optional(),
  hostDisplayName: z.string().min(1).max(160).optional(),
  resumeRoute: MobileWebResumeRouteSchema.optional(),
  ...ConnectionMetricsShape
})
  .strict()
  .superRefine(validateUniqueGrants)

const ShellConnectionSchema = ShellEnvelopeSchema.extend({
  type: z.literal('connection'),
  state: ConnectionStateSchema,
  ...ConnectionMetricsShape
}).strict()

const ShellNavigationSchema = ShellEnvelopeSchema.extend({
  type: z.literal('navigation'),
  sequence: SequenceSchema,
  route: MobileWebNavigationRouteSchema
}).strict()

const ShellHardwareBackSchema = ShellEnvelopeSchema.extend({
  type: z.literal('hardwareBack'),
  sequence: SequenceSchema
}).strict()

const ShellSuccessResponseSchema = ShellEnvelopeSchema.extend({
  type: z.literal('response'),
  requestId: RequestIdSchema,
  status: z.literal('success'),
  payload: z.unknown()
}).strict()

const ShellErrorResponseSchema = ShellEnvelopeSchema.extend({
  type: z.literal('response'),
  requestId: RequestIdSchema,
  status: z.literal('error'),
  error: z.object({ code: MobileWebBridgeErrorCodeSchema, retryable: z.boolean() }).strict()
}).strict()

const ShellEventSchema = ShellEnvelopeSchema.extend({
  type: z.literal('event'),
  subscriptionId: SubscriptionIdSchema,
  sequence: SequenceSchema,
  payload: z.unknown()
}).strict()

/**
 * The terminal frame for a subscription. `response` is keyed by `requestId` and only reports the
 * subscribe call itself; `event` carries values. Without this, a shell-side failure after the
 * subscribe succeeded was unrepresentable, so the page held a live entry forever and its screen
 * stayed on its last value with no error. Additive to bridge version 2 — a page built before it
 * fails the union parse and ignores the frame, exactly as it ignores any unknown type.
 */
const ShellSubscriptionClosedSchema = ShellEnvelopeSchema.extend({
  type: z.literal('subscriptionClosed'),
  subscriptionId: SubscriptionIdSchema,
  error: z.object({ code: MobileWebBridgeErrorCodeSchema, retryable: z.boolean() }).strict()
}).strict()

export const MobileWebBridgeShellMessageSchema = z.union([
  ShellInitSchema,
  ShellConnectionSchema,
  ShellNavigationSchema,
  ShellHardwareBackSchema,
  ShellSuccessResponseSchema,
  ShellErrorResponseSchema,
  ShellEventSchema,
  ShellSubscriptionClosedSchema
])

export type MobileWebBridgeErrorCode = z.infer<typeof MobileWebBridgeErrorCodeSchema>
export type MobileWebBridgePageMessage = z.infer<typeof MobileWebBridgePageMessageSchema>
export type MobileWebBridgeShellMessage = z.infer<typeof MobileWebBridgeShellMessageSchema>

export type { MobileWebBridgeMessageContext } from './bridge-message-parser'
export type MobileWebBridgeParseResult<T> = MobileWebBridgeMessageParseResult<T>

export function parseMobileWebBridgePageMessage(
  raw: string,
  expected: MobileWebBridgeMessageContext
): MobileWebBridgeParseResult<MobileWebBridgePageMessage> {
  return parseMobileWebBridgeMessage(raw, expected, MobileWebBridgePageMessageSchema)
}

/**
 * Shell->page frames are authored by an APK that can be newer than the page reading them, and a
 * frame the page cannot parse is dropped whole — for `init` that is every capability lost, not one
 * field. Parsing through the tolerant view strips a key the page does not declare instead of
 * failing the frame, which also keeps the PII fence: an undeclared `hostPath` or raw error
 * `message` never reaches the page either way. Page->shell stays strict; the shell is the
 * authority there.
 */
const TolerantShellMessageSchema = tolerantMobileWebShellPayload(MobileWebBridgeShellMessageSchema)
const TolerantShellInitSchema = tolerantMobileWebShellPayload(ShellInitSchema)

export function parseMobileWebBridgeShellMessage(
  raw: string,
  expected: MobileWebBridgeMessageContext
): MobileWebBridgeParseResult<MobileWebBridgeShellMessage> {
  return parseMobileWebBridgeMessage(raw, expected, TolerantShellMessageSchema)
}

export function parseMobileWebBridgeInitialMessage(
  raw: string
): MobileWebBridgeParseResult<z.infer<typeof ShellInitSchema>> {
  return parseMobileWebBridgeMessageDocument(raw, TolerantShellInitSchema)
}

function validateRequestOperation(
  request: { capability: MobileWebBridgeCapability; operation: string },
  context: z.RefinementCtx
): void {
  if (!isMobileWebBridgeOperation(request.capability, request.operation)) {
    context.addIssue({ code: 'custom', message: 'Unknown capability operation' })
  }
}

function validateSubscriptionRequest(
  request: {
    requestId: string
    subscriptionId: string
    capability: MobileWebBridgeCapability
    operation: string
  },
  context: z.RefinementCtx
): void {
  validateRequestOperation(request, context)
  if (request.requestId === request.subscriptionId) {
    context.addIssue({
      code: 'custom',
      message: 'Request and subscription IDs must be distinct',
      path: ['subscriptionId']
    })
  }
}

function validateUniqueGrants(
  message: { grants: { capability: MobileWebBridgeCapability; operation: string }[] },
  context: z.RefinementCtx
): void {
  const seen = new Set<string>()
  message.grants.forEach((grant, index) => {
    const key = `${grant.capability}.${grant.operation}`
    if (seen.has(key)) {
      context.addIssue({
        code: 'custom',
        message: 'Duplicate operation grant',
        path: ['grants', index]
      })
    }
    seen.add(key)
  })
}
