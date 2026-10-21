import { z } from 'zod'
import { MOBILE_PUSH_APNS_ENVIRONMENTS, MOBILE_PUSH_PLATFORMS } from '../mobile-push-contract'

export const NotificationUnsubscribeParams = z.object({
  subscriptionId: z
    .unknown()
    .transform((value) => (typeof value === 'string' && value.length > 0 ? value : ''))
    .pipe(z.string().min(1, 'Missing subscriptionId'))
})

// Why: notifications.getMissedSince is the catch-up RPC for mobile reconnect
// (#8129). The client passes the highest seq it has already delivered; the
// runtime returns only notifications dispatched after that seq. Because the
// desktop assigns a monotonic seq to every dispatched notification, the cut is
// exact and idempotent — re-requesting with the same watermark can never
// return an already-delivered event, so reconnects never duplicate local
// pushes (the adversarial-review gate for #8129).
// `epoch` names the counter lifetime lastSeenSeq came from (#8591). The desktop's
// seq restarts at 0 on every launch while the client's watermark is persisted, so
// without it a post-restart watermark silently cuts away everything. Optional: a
// client that predates the field keeps the seq-only cut.
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
  sound: z.boolean().optional()
})

export const NotificationRegisterPushParams = z
  .object({
    platform: z.enum(MOBILE_PUSH_PLATFORMS),
    token: z.string().min(1).max(4096),
    apnsEnvironment: z.enum(MOBILE_PUSH_APNS_ENVIRONMENTS).optional(),
    filter: NotificationPushFilterParams
  })
  // Why strict: the device identity is added by the handler, so a caller-supplied
  // `deviceId` must be an error, not a key silently dropped.
  .strict()
  // Why: an APNs token is only routable against the environment it was minted in,
  // so a missing environment must fail loudly rather than default to production.
  .refine((params) => params.platform !== 'ios' || params.apnsEnvironment !== undefined, {
    message: 'apnsEnvironment is required for ios'
  })

export const NotificationsSubscribeParams = z
  .object({ includeDesktopSuppressed: z.boolean().optional() })
  .optional()
