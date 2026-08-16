import { z } from 'zod'

const Generation = z.number().int().min(1).max(0xffff_ffff)
const Identity = z.string().min(1).max(256)
export const BROWSER_CLIENT_HOST_PAGE_INVENTORY_IDENTITY_MAX_JSON_BYTES = 384
const PageInventoryIdentity = Identity.refine(
  (value) =>
    browserClientHostJsonByteLength(value) <=
    BROWSER_CLIENT_HOST_PAGE_INVENTORY_IDENTITY_MAX_JSON_BYTES,
  'Browser page inventory identity exceeds its JSON byte budget'
)
const CommandSequence = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
export const BROWSER_CLIENT_HOST_PAGE_INVENTORY_MAX_PAGES = 256
export const BROWSER_CLIENT_HOST_PAGE_INVENTORY_MAX_BYTES = 768 * 1024
export const BROWSER_CLIENT_HOST_PAGE_INVENTORY_URL_MAX_LENGTH = 8192

export const BROWSER_CLIENT_HOST_PAGE_COMMAND_PROTOCOL_VERSION = 1 as const
const PageCommandProtocolVersion = z.literal(BROWSER_CLIENT_HOST_PAGE_COMMAND_PROTOCOL_VERSION)
export const BROWSER_CLIENT_HOST_PAGE_INVENTORY_PROTOCOL_VERSION = 1 as const
const PageInventoryProtocolVersion = z.literal(BROWSER_CLIENT_HOST_PAGE_INVENTORY_PROTOCOL_VERSION)

export const BrowserHostLeaseAuthority = z.object({
  authorityRuntimeId: Identity,
  authorityEpoch: Identity,
  browserHostClientId: Identity,
  browserHostGeneration: Generation
})

export type BrowserHostLeaseAuthority = z.infer<typeof BrowserHostLeaseAuthority>

export const BrowserClientHostedPageInventory = z.object({
  authorityRuntimeId: PageInventoryIdentity,
  authorityEpoch: PageInventoryIdentity,
  browserHostClientId: PageInventoryIdentity,
  browserHostGeneration: Generation,
  browserPageId: PageInventoryIdentity,
  pageHostGeneration: Generation,
  browserProfileId: PageInventoryIdentity,
  executionHostKey: PageInventoryIdentity,
  state: z.enum(['active', 'outcomeUnknown']),
  currentUrl: z.string().max(BROWSER_CLIENT_HOST_PAGE_INVENTORY_URL_MAX_LENGTH).optional()
})

export type BrowserClientHostedPageInventory = z.infer<typeof BrowserClientHostedPageInventory>

export const BrowserClientHostedPageInventoryList = z
  .array(BrowserClientHostedPageInventory)
  .max(BROWSER_CLIENT_HOST_PAGE_INVENTORY_MAX_PAGES)
  .superRefine((pages, context) => {
    const pageIds = new Set<string>()
    for (const [index, page] of pages.entries()) {
      if (pageIds.has(page.browserPageId)) {
        context.addIssue({
          code: 'custom',
          message: 'Duplicate browser page inventory identity',
          path: [index, 'browserPageId']
        })
      }
      pageIds.add(page.browserPageId)
    }
    if (
      browserClientHostedPageInventoryByteLength(pages) >
      BROWSER_CLIENT_HOST_PAGE_INVENTORY_MAX_BYTES
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Browser page inventory exceeds its byte budget'
      })
    }
  })

export function browserClientHostedPageInventoryByteLength(
  pages: readonly BrowserClientHostedPageInventory[]
): number {
  return browserClientHostJsonByteLength(pages)
}

function browserClientHostJsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

export const BrowserClientHostAttachParams = z
  .object({
    authorityRuntimeId: Identity,
    browserHostClientId: Identity,
    hostCapabilities: z.array(z.string().min(1).max(128)).max(32),
    pageCommandProtocolVersion: PageCommandProtocolVersion.optional(),
    pageInventoryProtocolVersion: PageInventoryProtocolVersion.optional(),
    pageInventory: BrowserClientHostedPageInventoryList.optional()
  })
  .superRefine((params, context) => {
    if (
      (params.pageInventoryProtocolVersion === undefined) !==
      (params.pageInventory === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Browser page inventory negotiation is incomplete'
      })
    }
    for (const [index, page] of (params.pageInventory ?? []).entries()) {
      if (page.browserHostClientId !== params.browserHostClientId) {
        context.addIssue({
          code: 'custom',
          message: 'Browser page inventory authority does not match the attaching host',
          path: ['pageInventory', index]
        })
      }
    }
  })

export const BrowserClientHostReady = z.object({
  type: z.literal('ready'),
  authorityEpoch: Identity,
  browserHostGeneration: Generation,
  pageCommandProtocolVersion: PageCommandProtocolVersion.optional(),
  pageInventoryProtocolVersion: PageInventoryProtocolVersion.optional()
})

const BrowserClientHostRevoked = z.object({
  type: z.literal('revoked'),
  authorityEpoch: Identity,
  browserHostGeneration: Generation,
  reason: z.enum(['replaced', 'released'])
})

export const BrowserClientHostLeaseAuthority = BrowserHostLeaseAuthority.extend({
  pageCommandProtocolVersion: PageCommandProtocolVersion.optional(),
  pageInventoryProtocolVersion: PageInventoryProtocolVersion.optional()
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

export const BrowserClientHostPageCommand = z.discriminatedUnion('type', [
  BrowserClientHostCreatePageCommand,
  BrowserClientHostNavigateCommand
])

export const BrowserClientHostCommandEvent = BrowserClientPageCommandAuthority.extend({
  type: z.literal('command'),
  command: BrowserClientHostPageCommand
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

export const BrowserClientHostCommandResultAck = z.object({ accepted: z.boolean() })

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
