import { z } from 'zod'
import {
  MOBILE_PUSH_APNS_ENVIRONMENTS,
  MOBILE_PUSH_PLATFORMS,
  MOBILE_PUSH_TOKEN_DIGEST_MAX_CHARS
} from '../../notifications/mobile-push-contract'

export const NotificationUnsubscribeParams = z.object({
  subscriptionId: z
    .unknown()
    .transform((value) => (typeof value === 'string' && value.length > 0 ? value : ''))
    .pipe(z.string().min(1, 'Missing subscriptionId'))
})

// Catch up after the delivered sequence (#8129); epoch identifies its counter lifetime across desktop restarts
// (#8591). Old clients retain seq-only cuts; replaying a watermark cannot duplicate already-delivered sequences.
export const NotificationGetMissedSinceParams = z.object({
  lastSeenSeq: z.number().int().min(0, 'lastSeenSeq must be a non-negative integer'),
  epoch: z.string().optional(),
  includeDesktopSuppressed: z.boolean().optional(),
  deliveredPushes: z
    .array(
      z.object({
        notificationId: z.string().min(1).max(2048),
        notificationEpoch: z.string().min(1).max(128),
        notificationSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
      })
    )
    .max(256)
    .optional()
})

export const NotificationPushFilterParams = z.object({
  onlyWhenDesktopAway: z.boolean().optional(),
  onlyWhenAgentNeedsInput: z.boolean().optional(),
  sound: z.boolean().optional()
})

export const NotificationRegisterPushParams = z
  .object({
    platform: z.enum(MOBILE_PUSH_PLATFORMS),
    token: z.string().min(1).max(4096),
    apnsEnvironment: z.enum(MOBILE_PUSH_APNS_ENVIRONMENTS).optional(),
    filter: NotificationPushFilterParams
  })
  // Device identity is handler-owned; reject caller-supplied deviceId instead of silently dropping it.
  .strict()
  // APNs tokens require their minting environment; never default a missing one to production.
  .refine((params) => params.platform !== 'ios' || params.apnsEnvironment !== undefined, {
    message: 'apnsEnvironment is required for ios'
  })

export const NotificationsSubscribeParams = z
  .object({ includeDesktopSuppressed: z.boolean().optional() })
  .optional()

export const NotificationReportDesktopPresenceParams = z.object({ away: z.boolean() })

export const NOTIFICATION_PUSH_COVERAGE_MAX_DIGESTS = 64

// The alert's kind lets the owning host answer only for alerts it pushes its own phones itself.
export const NotificationPushCoverageParams = z.object({
  tokenDigests: z
    .array(z.string().min(1).max(MOBILE_PUSH_TOKEN_DIGEST_MAX_CHARS))
    .max(NOTIFICATION_PUSH_COVERAGE_MAX_DIGESTS),
  source: z.string().min(1).max(64),
  agentState: z.string().min(1).max(64).optional(),
  /** The host's own pane key for a terminal alert. */
  paneKey: z.string().min(1).max(1024).optional(),
  /** A native chat's attention, which host main always pushes. */
  structured: z.boolean().optional()
})
