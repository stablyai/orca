import { z } from 'zod'

const Generation = z.number().int().min(1).max(0xffff_ffff)
const Identity = z.string().min(1).max(256)

export const BrowserClientHostAttachParams = z.object({
  authorityRuntimeId: Identity,
  browserHostClientId: Identity,
  hostCapabilities: z.array(z.string().min(1).max(128)).max(32)
})

export const BrowserClientHostReady = z.object({
  type: z.literal('ready'),
  authorityEpoch: Identity,
  browserHostGeneration: Generation
})

export const BrowserClientHostEvent = z.discriminatedUnion('type', [
  BrowserClientHostReady,
  z.object({
    type: z.literal('revoked'),
    authorityEpoch: Identity,
    browserHostGeneration: Generation,
    reason: z.enum(['replaced', 'released'])
  })
])

export const BrowserHostLeaseAuthority = z.object({
  authorityRuntimeId: Identity,
  authorityEpoch: Identity,
  browserHostClientId: Identity,
  browserHostGeneration: Generation
})

export type BrowserHostLeaseAuthority = z.infer<typeof BrowserHostLeaseAuthority>

const BrowserNetworkNativeExecutionHost = z.object({
  kind: z.literal('native'),
  runtimeId: Identity,
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
})

const BrowserNetworkSshExecutionHost = z.object({
  kind: z.literal('ssh'),
  targetId: Identity,
  providerEpoch: Identity,
  connectionGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
})

export const BrowserNetworkExecutionHost = z.discriminatedUnion('kind', [
  BrowserNetworkNativeExecutionHost,
  BrowserNetworkSshExecutionHost
])

export type BrowserNetworkExecutionHost = z.infer<typeof BrowserNetworkExecutionHost>

export const BrowserNetworkTunnelAttachParams = BrowserHostLeaseAuthority.extend({
  executionHost: BrowserNetworkExecutionHost
})

export const BrowserNetworkTunnelEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), tunnelGeneration: Generation }),
  z.object({ type: z.literal('closed'), tunnelGeneration: Generation })
])
