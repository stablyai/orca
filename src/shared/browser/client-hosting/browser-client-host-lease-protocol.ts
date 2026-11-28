import { browserClientHostJsonByteLength } from './browser-client-host-json-byte-length'
import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { BROWSER_CLIENT_FILE_CHANNEL_PROTOCOL_VERSION } from './browser-client-file-channel-protocol'

export const BROWSER_CLIENT_PAGE_INITIALIZATION_CAPABILITY = 'page-initialization-commit-v1'

export const BrowserClientHostGeneration = lazyZodSchema(() =>
  z.number().int().min(1).max(0xffff_ffff)
)
export const BrowserClientHostIdentity = lazyZodSchema(() => z.string().min(1).max(256))
export const BROWSER_CLIENT_HOST_PAGE_INVENTORY_IDENTITY_MAX_JSON_BYTES = 384
const PageInventoryIdentity = lazyZodSchema(() =>
  BrowserClientHostIdentity.refine(
    (value) =>
      browserClientHostJsonByteLength(value) <=
      BROWSER_CLIENT_HOST_PAGE_INVENTORY_IDENTITY_MAX_JSON_BYTES,
    'Browser page inventory identity exceeds its JSON byte budget'
  )
)
export const BROWSER_CLIENT_HOST_PAGE_INVENTORY_MAX_PAGES = 256
export const BROWSER_CLIENT_HOST_PAGE_INVENTORY_MAX_BYTES = 768 * 1024
export const BROWSER_CLIENT_HOST_PAGE_INVENTORY_URL_MAX_LENGTH = 8192

export const BROWSER_CLIENT_HOST_PAGE_COMMAND_PROTOCOL_VERSION = 1 as const
export const PageCommandProtocolVersion = lazyZodSchema(() =>
  z.literal(BROWSER_CLIENT_HOST_PAGE_COMMAND_PROTOCOL_VERSION)
)
export const BROWSER_CLIENT_HOST_PAGE_INVENTORY_PROTOCOL_VERSION = 1 as const
const PageInventoryProtocolVersion = lazyZodSchema(() =>
  z.literal(BROWSER_CLIENT_HOST_PAGE_INVENTORY_PROTOCOL_VERSION)
)
export const BROWSER_CLIENT_HOST_LEASE_RECONNECT_PROTOCOL_VERSION = 1 as const
const LeaseReconnectProtocolVersion = lazyZodSchema(() =>
  z.literal(BROWSER_CLIENT_HOST_LEASE_RECONNECT_PROTOCOL_VERSION)
)
export const BROWSER_CLIENT_HOST_PAGE_RECONCILIATION_PROTOCOL_VERSION = 1 as const
const PageReconciliationProtocolVersion = lazyZodSchema(() =>
  z.literal(BROWSER_CLIENT_HOST_PAGE_RECONCILIATION_PROTOCOL_VERSION)
)
const FileChannelProtocolVersion = lazyZodSchema(() =>
  z.literal(BROWSER_CLIENT_FILE_CHANNEL_PROTOCOL_VERSION)
)

/** An unknown runtime ID means a newer authority exists; retain live guests while waiting for replacement instead of diagnosing host failure. */
export const BROWSER_CLIENT_HOST_AUTHORITY_MISMATCH_CODE = 'browser_client_host_authority_mismatch'

export const BrowserHostLeaseAuthority = lazyZodSchema(() =>
  z.object({
    authorityRuntimeId: BrowserClientHostIdentity,
    authorityEpoch: BrowserClientHostIdentity,
    browserHostClientId: BrowserClientHostIdentity,
    browserHostGeneration: BrowserClientHostGeneration
  })
)

export type BrowserHostLeaseAuthority = z.infer<typeof BrowserHostLeaseAuthority>

export const BrowserClientHostedPageAuthority = lazyZodSchema(() =>
  BrowserHostLeaseAuthority.extend({
    pageHostGeneration: BrowserClientHostGeneration
  })
)

export const BrowserClientHostedPageInventory = lazyZodSchema(() =>
  z.object({
    authorityRuntimeId: PageInventoryIdentity,
    authorityEpoch: PageInventoryIdentity,
    browserHostClientId: PageInventoryIdentity,
    browserHostGeneration: BrowserClientHostGeneration,
    browserPageId: PageInventoryIdentity,
    pageHostGeneration: BrowserClientHostGeneration,
    browserProfileId: PageInventoryIdentity,
    executionHostKey: PageInventoryIdentity,
    state: z.enum(['active', 'outcomeUnknown']),
    currentUrl: z.string().max(BROWSER_CLIENT_HOST_PAGE_INVENTORY_URL_MAX_LENGTH).optional(),
    // Echo createPage metadata to rebuild records after runtime restart; absent for older placements.
    workspaceId: PageInventoryIdentity.optional()
  })
)

export type BrowserClientHostedPageInventory = z.infer<typeof BrowserClientHostedPageInventory>

export const BrowserClientHostedPageInventoryList = lazyZodSchema(() =>
  z
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
)

export function browserClientHostedPageInventoryByteLength(
  pages: readonly BrowserClientHostedPageInventory[]
): number {
  return browserClientHostJsonByteLength(pages)
}

export const BrowserClientHostAttachParams = lazyZodSchema(() =>
  z
    .object({
      authorityRuntimeId: BrowserClientHostIdentity,
      browserHostClientId: BrowserClientHostIdentity,
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
)

export const BrowserClientHostReady = lazyZodSchema(() =>
  z.object({
    type: z.literal('ready'),
    authorityEpoch: BrowserClientHostIdentity,
    browserHostGeneration: BrowserClientHostGeneration,
    pageCommandProtocolVersion: PageCommandProtocolVersion.optional(),
    pageInventoryProtocolVersion: PageInventoryProtocolVersion.optional(),
    leaseReconnectProtocolVersion: LeaseReconnectProtocolVersion.optional(),
    pageReconciliationProtocolVersion: PageReconciliationProtocolVersion.optional(),
    fileChannelProtocolVersion: FileChannelProtocolVersion.optional()
  })
)

export const BrowserClientHostRevoked = lazyZodSchema(() =>
  z.object({
    type: z.literal('revoked'),
    authorityEpoch: BrowserClientHostIdentity,
    browserHostGeneration: BrowserClientHostGeneration,
    reason: z.enum(['replaced', 'released'])
  })
)

export const BrowserClientHostLeaseAuthority = lazyZodSchema(() =>
  BrowserHostLeaseAuthority.extend({
    pageCommandProtocolVersion: PageCommandProtocolVersion.optional(),
    pageInventoryProtocolVersion: PageInventoryProtocolVersion.optional(),
    leaseReconnectProtocolVersion: LeaseReconnectProtocolVersion.optional(),
    pageReconciliationProtocolVersion: PageReconciliationProtocolVersion.optional(),
    fileChannelProtocolVersion: FileChannelProtocolVersion.optional()
  })
)

export type BrowserClientHostLeaseAuthority = z.infer<typeof BrowserClientHostLeaseAuthority>
