import { z } from 'zod'
import { isUtf8ByteLengthWithinLimit } from '../utf8-byte-limits'

/** Caps keep sidecar frames a snapshot, not a dump of workspace state. */
export const PLUGIN_SIDECAR_PAYLOAD_MAX_BYTES = 8 * 1024
export const PLUGIN_SIDECAR_MAILBOX_SLOT_LIMIT = 256

export const PLUGIN_SIDECAR_CHANNELS = ['presence', 'generic'] as const
export type PluginSidecarChannel = (typeof PLUGIN_SIDECAR_CHANNELS)[number]

export const PLUGIN_SIDECAR_OPS = ['set', 'clear'] as const
export type PluginSidecarOp = (typeof PLUGIN_SIDECAR_OPS)[number]

export const sidecarPublishParamsSchema = z
  .object({
    channel: z.enum(PLUGIN_SIDECAR_CHANNELS),
    op: z.enum(PLUGIN_SIDECAR_OPS),
    payload: z.json().optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.op === 'set' && value.payload === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'payload is required for set',
        path: ['payload']
      })
      return
    }
    if (value.op === 'clear' && value.payload !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'payload must be omitted for clear',
        path: ['payload']
      })
      return
    }
    if (value.payload === undefined) {
      return
    }
    if (
      !isUtf8ByteLengthWithinLimit(JSON.stringify(value.payload), PLUGIN_SIDECAR_PAYLOAD_MAX_BYTES)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'payload exceeds sidecar byte limit',
        path: ['payload']
      })
    }
  })

export type PluginSidecarPublishParams = z.infer<typeof sidecarPublishParamsSchema>

export const sidecarPlacementSchema = z
  .object({
    pluginProcess: z.literal('runtime-host'),
    discordIpcMustRun: z.literal('machine-with-discord'),
    hostForwards: z.literal('sidecar-frames'),
    hostDoesNotForward: z.tuple([z.literal('discord-ipc-bytes'), z.literal('companion-http')]),
    mailboxAvailable: z.literal(true),
    companionStillValid: z.literal(true),
    lastPublishedAt: z.number().int().nonnegative().nullable()
  })
  .strict()

export type PluginSidecarPlacement = z.infer<typeof sidecarPlacementSchema>

export const sidecarPublishResultSchema = z
  .object({
    accepted: z.literal(true),
    delivery: z.literal('stored'),
    placement: sidecarPlacementSchema
  })
  .strict()

export type PluginSidecarPublishResult = z.infer<typeof sidecarPublishResultSchema>

export const sidecarStoredFrameSchema = z
  .object({
    pluginKey: z.string().min(1),
    channel: z.enum(PLUGIN_SIDECAR_CHANNELS),
    op: z.enum(PLUGIN_SIDECAR_OPS),
    payload: z.json().nullable(),
    publishedAt: z.number().int().nonnegative()
  })
  .strict()

export type PluginSidecarStoredFrame = z.infer<typeof sidecarStoredFrameSchema>

const sidecarLatestParamsShape = z
  .object({
    pluginKey: z.string().min(1).optional()
  })
  .strict()

export const sidecarClientHostLatestParamsSchema = sidecarLatestParamsShape.optional()

export const sidecarClientHostLatestResultSchema = z
  .object({
    frames: z.array(sidecarStoredFrameSchema).max(PLUGIN_SIDECAR_MAILBOX_SLOT_LIMIT)
  })
  .strict()

export type PluginSidecarClientHostLatestResult = z.infer<
  typeof sidecarClientHostLatestResultSchema
>

export function buildSidecarPlacement(lastPublishedAt: number | null): PluginSidecarPlacement {
  return {
    pluginProcess: 'runtime-host',
    discordIpcMustRun: 'machine-with-discord',
    hostForwards: 'sidecar-frames',
    hostDoesNotForward: ['discord-ipc-bytes', 'companion-http'],
    mailboxAvailable: true,
    companionStillValid: true,
    lastPublishedAt
  }
}
