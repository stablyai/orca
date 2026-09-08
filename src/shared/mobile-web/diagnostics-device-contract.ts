import { z } from 'zod'

export const DiagnosticsEmptyPayloadSchema = z.object({}).strict()
const path = z.enum(['lan', 'tailscale', 'relay'])
export const DiagnosticsSnapshotResultSchema = z.object({
  state: z.enum([
    'connecting',
    'handshaking',
    'connected',
    'disconnected',
    'reconnecting',
    'auth-failed'
  ]),
  reconnectAttempts: z.number().nonnegative(),
  lastConnectedAt: z.number().nullable(),
  activePath: path,
  pendingPath: path.nullable(),
  endpointIsTailscale: z.boolean(),
  platform: z.string().max(128),
  appVersion: z.string().max(128),
  desktopAppVersion: z.string().max(128).nullable(),
  entries: z
    .array(
      z.object({
        id: z.string().max(128),
        ts: z.number(),
        level: z.enum(['info', 'success', 'warn', 'error']),
        message: z.string().max(2048),
        detail: z.string().max(2048).optional(),
        code: z.string().max(128).optional(),
        path: path.optional()
      })
    )
    .max(200),
  mobileWeb: z.record(z.string(), z.union([z.string().max(256), z.number(), z.null()]))
})
export const DiagnosticsProbePayloadSchema = z
  .object({ target: z.enum(['internet', 'host']) })
  .strict()
export const DiagnosticsProbeResultSchema = z.object({ reachable: z.boolean() })
export const DiagnosticsSubmitPayloadSchema = z
  .object({
    report: z.string().max(64 * 1024),
    appVersion: z.string().max(128),
    platform: z.string().max(128)
  })
  .strict()
export const DiagnosticsSubmitResultSchema = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string().max(2048) })
])
export type DiagnosticsSnapshot = z.infer<typeof DiagnosticsSnapshotResultSchema>
export type DiagnosticsSubmission = z.infer<typeof DiagnosticsSubmitPayloadSchema>
