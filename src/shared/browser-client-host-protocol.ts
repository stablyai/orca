import { z } from 'zod'
import {
  BrowserClientAutomationCommand,
  BrowserClientAutomationResult
} from './browser-client-automation-protocol'
import { BROWSER_CLIENT_FILE_CHANNEL_PROTOCOL_VERSION } from './browser-client-file-channel-protocol'

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
export const BROWSER_CLIENT_HOST_LEASE_RECONNECT_PROTOCOL_VERSION = 1 as const
const LeaseReconnectProtocolVersion = z.literal(
  BROWSER_CLIENT_HOST_LEASE_RECONNECT_PROTOCOL_VERSION
)
export const BROWSER_CLIENT_HOST_PAGE_RECONCILIATION_PROTOCOL_VERSION = 1 as const
const PageReconciliationProtocolVersion = z.literal(
  BROWSER_CLIENT_HOST_PAGE_RECONCILIATION_PROTOCOL_VERSION
)
const FileChannelProtocolVersion = z.literal(BROWSER_CLIENT_FILE_CHANNEL_PROTOCOL_VERSION)

/**
 * Sent when an attach names a runtime id this process does not have. It means "a newer authority
 * exists", not "this host is broken" — a client that still holds live guests should wait for the
 * replacement rather than tear them down.
 */
export const BROWSER_CLIENT_HOST_AUTHORITY_MISMATCH_CODE = 'browser_client_host_authority_mismatch'

export const BrowserHostLeaseAuthority = z.object({
  authorityRuntimeId: Identity,
  authorityEpoch: Identity,
  browserHostClientId: Identity,
  browserHostGeneration: Generation
})

export type BrowserHostLeaseAuthority = z.infer<typeof BrowserHostLeaseAuthority>

const BrowserClientHostedPageAuthority = BrowserHostLeaseAuthority.extend({
  pageHostGeneration: Generation
})

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
  currentUrl: z.string().max(BROWSER_CLIENT_HOST_PAGE_INVENTORY_URL_MAX_LENGTH).optional(),
  // Echoed back from the createPage command so a restarted runtime can rebuild the page record it
  // lost with its memory. Absent for pages placed by a runtime that predates the field.
  workspaceId: PageInventoryIdentity.optional()
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
    pageInventory: BrowserClientHostedPageInventoryList.optional(),
    leaseReconnectProtocolVersion: LeaseReconnectProtocolVersion.optional(),
    pageReconciliationProtocolVersion: PageReconciliationProtocolVersion.optional(),
    fileChannelProtocolVersion: FileChannelProtocolVersion.optional()
  })
  .superRefine((params, context) => {
    if (
      params.fileChannelProtocolVersion !== undefined &&
      params.pageCommandProtocolVersion !== 1
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Browser file channel requires command negotiation'
      })
    }
    if (
      (params.pageInventoryProtocolVersion === undefined) !==
      (params.pageInventory === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Browser page inventory negotiation is incomplete'
      })
    }
    if (
      params.leaseReconnectProtocolVersion !== undefined &&
      params.pageInventoryProtocolVersion === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Browser host reconnect requires page inventory negotiation'
      })
    }
    if (
      params.pageReconciliationProtocolVersion !== undefined &&
      (params.pageCommandProtocolVersion !== 1 || params.pageInventoryProtocolVersion !== 1)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Browser page reconciliation requires command and inventory negotiation'
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
  pageInventoryProtocolVersion: PageInventoryProtocolVersion.optional(),
  leaseReconnectProtocolVersion: LeaseReconnectProtocolVersion.optional(),
  pageReconciliationProtocolVersion: PageReconciliationProtocolVersion.optional(),
  fileChannelProtocolVersion: FileChannelProtocolVersion.optional()
})

const BrowserClientHostRevoked = z.object({
  type: z.literal('revoked'),
  authorityEpoch: Identity,
  browserHostGeneration: Generation,
  reason: z.enum(['replaced', 'released'])
})

export const BrowserClientHostLeaseAuthority = BrowserHostLeaseAuthority.extend({
  pageCommandProtocolVersion: PageCommandProtocolVersion.optional(),
  pageInventoryProtocolVersion: PageInventoryProtocolVersion.optional(),
  leaseReconnectProtocolVersion: LeaseReconnectProtocolVersion.optional(),
  pageReconciliationProtocolVersion: PageReconciliationProtocolVersion.optional(),
  fileChannelProtocolVersion: FileChannelProtocolVersion.optional()
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

const BrowserNetworkWslExecutionHost = z.object({
  kind: z.literal('wsl'),
  runtimeId: Identity,
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  distro: Identity
})

export const BrowserNetworkExecutionHost = z.discriminatedUnion('kind', [
  BrowserNetworkNativeExecutionHost,
  BrowserNetworkSshExecutionHost,
  BrowserNetworkWslExecutionHost
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
  executionHostKey: Identity,
  // The client never interprets this; it only echoes it back in the page inventory so a restarted
  // runtime can rebuild the workspace association it holds nowhere else.
  workspaceId: Identity.optional()
})

const BrowserClientHostNavigateCommand = z.object({
  type: z.literal('navigate'),
  url: z.string().min(1).max(8192)
})

const BrowserClientHostReclaimPageCommand = z.object({
  type: z.literal('reclaimPage'),
  previousAuthority: BrowserClientHostedPageAuthority,
  browserProfileId: Identity,
  executionHostKey: Identity,
  workspaceId: Identity.optional()
})

const BrowserClientHostClosePageCommand = z.object({
  type: z.literal('closePage'),
  targetAuthority: BrowserClientHostedPageAuthority
})

const BrowserClientHostRestorePageCommand = z.object({
  type: z.literal('restorePage'),
  browserProfileId: Identity,
  executionHostKey: Identity,
  url: z.string().min(1).max(8192).optional(),
  workspaceId: Identity.optional()
})

export const BrowserClientHostPageCommand = z.discriminatedUnion('type', [
  BrowserClientHostCreatePageCommand,
  BrowserClientHostNavigateCommand,
  BrowserClientHostReclaimPageCommand,
  BrowserClientHostClosePageCommand,
  BrowserClientHostRestorePageCommand,
  BrowserClientAutomationCommand
])

export const BrowserClientHostCommandEvent = BrowserClientPageCommandAuthority.extend({
  type: z.literal('command'),
  command: BrowserClientHostPageCommand
}).superRefine((event, context) => {
  if (
    event.command.type === 'createPage' ||
    event.command.type === 'navigate' ||
    event.command.type === 'automation'
  ) {
    return
  }
  if (event.pageReconciliationProtocolVersion !== 1) {
    context.addIssue({
      code: 'custom',
      message: 'Browser page reconciliation command was not negotiated'
    })
  }
  const previousAuthority =
    event.command.type === 'reclaimPage'
      ? event.command.previousAuthority
      : event.command.type === 'closePage'
        ? event.command.targetAuthority
        : null
  if (previousAuthority && previousAuthority.browserHostClientId !== event.browserHostClientId) {
    context.addIssue({
      code: 'custom',
      message: 'Browser page reconciliation client authority does not match'
    })
  }
  if (
    event.command.type === 'reclaimPage' &&
    event.command.previousAuthority.authorityEpoch === event.authorityEpoch
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Browser page reclaim requires an older authority epoch'
    })
  }
})

export type BrowserClientHostCommandEvent = z.infer<typeof BrowserClientHostCommandEvent>

export const BrowserClientHostCommandResult = BrowserClientAutomationResult

export type BrowserClientHostCommandResult = z.infer<typeof BrowserClientHostCommandResult>

export const BrowserClientHostCommandResultParams = BrowserClientPageCommandAuthority.extend({
  result: BrowserClientHostCommandResult
})

export const BrowserClientHostCommandResultAck = z.object({ accepted: z.boolean() })

export const BrowserClientHostEvent = z.union([
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
