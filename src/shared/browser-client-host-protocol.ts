import { z } from 'zod'

const Generation = z.number().int().min(1).max(0xffff_ffff)
const Identity = z.string().min(1).max(256)
const CommandSequence = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)

export const BROWSER_CLIENT_HOST_PAGE_COMMAND_PROTOCOL_VERSION = 1 as const
const PageCommandProtocolVersion = z.literal(BROWSER_CLIENT_HOST_PAGE_COMMAND_PROTOCOL_VERSION)

export const BrowserClientHostAttachParams = z.object({
  authorityRuntimeId: Identity,
  browserHostClientId: Identity,
  hostCapabilities: z.array(z.string().min(1).max(128)).max(32),
  pageCommandProtocolVersion: PageCommandProtocolVersion.optional()
})

export const BrowserClientHostReady = z.object({
  type: z.literal('ready'),
  authorityEpoch: Identity,
  browserHostGeneration: Generation,
  pageCommandProtocolVersion: PageCommandProtocolVersion.optional()
})

const BrowserClientHostRevoked = z.object({
  type: z.literal('revoked'),
  authorityEpoch: Identity,
  browserHostGeneration: Generation,
  reason: z.enum(['replaced', 'released'])
})

export const BrowserHostLeaseAuthority = z.object({
  authorityRuntimeId: Identity,
  authorityEpoch: Identity,
  browserHostClientId: Identity,
  browserHostGeneration: Generation
})

export type BrowserHostLeaseAuthority = z.infer<typeof BrowserHostLeaseAuthority>

export const BrowserClientHostLeaseAuthority = BrowserHostLeaseAuthority.extend({
  pageCommandProtocolVersion: PageCommandProtocolVersion.optional()
})

export type BrowserClientHostLeaseAuthority = z.infer<typeof BrowserClientHostLeaseAuthority>

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

const BrowserClientPageCommandAuthority = BrowserClientHostLeaseAuthority.extend({
  pageCommandProtocolVersion: PageCommandProtocolVersion,
  browserPageId: Identity,
  pageHostGeneration: Generation,
  commandSequence: CommandSequence,
  commandId: Identity
})

const BrowserClientHostCreatePageCommand = z.object({
  type: z.literal('createPage'),
  browserProfileId: Identity,
  executionHostKey: Identity
})

const BrowserClientHostNavigateCommand = z.object({
  type: z.literal('navigate'),
  url: z.string().min(1).max(8192)
})

export const BrowserClientHostCommandEvent = BrowserClientPageCommandAuthority.extend({
  type: z.literal('command'),
  command: z.discriminatedUnion('type', [
    BrowserClientHostCreatePageCommand,
    BrowserClientHostNavigateCommand
  ])
})

export type BrowserClientHostCommandEvent = z.infer<typeof BrowserClientHostCommandEvent>

export const BrowserClientHostCommandResult = z.discriminatedUnion('status', [
  z.object({ status: z.literal('completed') }),
  z.object({ status: z.literal('failed'), errorCode: Identity })
])

export type BrowserClientHostCommandResult = z.infer<typeof BrowserClientHostCommandResult>

export const BrowserClientHostCommandResultParams = BrowserClientPageCommandAuthority.extend({
  result: BrowserClientHostCommandResult
})

export const BrowserClientHostLeaseEvent = z.discriminatedUnion('type', [
  BrowserClientHostReady,
  BrowserClientHostRevoked
])

export const BrowserClientHostEvent = z.discriminatedUnion('type', [
  BrowserClientHostReady,
  BrowserClientHostRevoked,
  BrowserClientHostCommandEvent
])

export const BrowserNetworkTunnelAttachParams = BrowserHostLeaseAuthority.extend({
  executionHost: BrowserNetworkExecutionHost
})

export const BrowserNetworkTunnelEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), tunnelGeneration: Generation }),
  z.object({ type: z.literal('closed'), tunnelGeneration: Generation })
])
