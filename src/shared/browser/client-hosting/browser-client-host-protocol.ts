import {
  BrowserClientProfileMetadata,
  BrowserClientProfileSwitchCommand
} from './browser-client-profile-switch-protocol'
import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { BrowserNetworkExecutionHost } from './browser-network-execution-host'
import {
  BROWSER_CLIENT_AUTOMATION_RESULT_CHUNK_MAX_BYTES,
  BROWSER_CLIENT_AUTOMATION_STAGED_RESULT_MAX_BYTES,
  BrowserClientAutomationCommand,
  BrowserClientAutomationResult as BrowserClientHostCommandResult
} from './browser-client-automation-protocol'
import {
  BrowserClientHostGeneration as Generation,
  BrowserClientHostIdentity as Identity,
  BrowserClientHostLeaseAuthority,
  BrowserClientHostReady,
  BrowserClientHostRevoked,
  BrowserClientHostedPageAuthority,
  BrowserHostLeaseAuthority,
  PageCommandProtocolVersion
} from './browser-client-host-lease-protocol'

export {
  BROWSER_CLIENT_HOST_AUTHORITY_MISMATCH_CODE,
  BROWSER_CLIENT_HOST_LEASE_RECONNECT_PROTOCOL_VERSION,
  BROWSER_CLIENT_HOST_PAGE_COMMAND_PROTOCOL_VERSION,
  BROWSER_CLIENT_HOST_PAGE_INVENTORY_IDENTITY_MAX_JSON_BYTES,
  BROWSER_CLIENT_HOST_PAGE_INVENTORY_MAX_BYTES,
  BROWSER_CLIENT_HOST_PAGE_INVENTORY_MAX_PAGES,
  BROWSER_CLIENT_HOST_PAGE_INVENTORY_PROTOCOL_VERSION,
  BROWSER_CLIENT_HOST_PAGE_INVENTORY_URL_MAX_LENGTH,
  BROWSER_CLIENT_HOST_PAGE_RECONCILIATION_PROTOCOL_VERSION,
  BROWSER_CLIENT_PAGE_INITIALIZATION_CAPABILITY,
  BrowserClientHostAttachParams,
  BrowserClientHostLeaseAuthority,
  BrowserClientHostReady,
  BrowserClientHostedPageInventory,
  BrowserClientHostedPageInventoryList,
  BrowserHostLeaseAuthority,
  browserClientHostedPageInventoryByteLength
} from './browser-client-host-lease-protocol'

const CommandSequence = lazyZodSchema(() => z.number().int().min(1).max(Number.MAX_SAFE_INTEGER))

const BrowserClientPageCommandAuthority = lazyZodSchema(() =>
  BrowserClientHostLeaseAuthority.extend({
    pageCommandProtocolVersion: PageCommandProtocolVersion,
    browserPageId: Identity,
    pageHostGeneration: Generation,
    commandSequence: CommandSequence,
    commandId: Identity
  })
)

const BrowserClientHostCreatePageCommand = lazyZodSchema(() =>
  z.object({
    type: z.literal('createPage'),
    initialUrl: z.string().min(1).optional(),
    browserProfileId: Identity,
    // Sent only to profile-switch-v1 desktops, for host-owned profiles the desktop does not know.
    profile: BrowserClientProfileMetadata.optional(),
    executionHostKey: Identity,
    // Echo opaque workspace metadata in page inventory so restarted runtimes can rebuild otherwise lost associations.
    workspaceId: Identity.optional()
  })
)

const BrowserClientHostNavigateCommand = lazyZodSchema(() =>
  z.object({
    type: z.literal('navigate'),
    url: z.string().min(1)
  })
)

const BrowserClientHostReclaimPageCommand = lazyZodSchema(() =>
  z.object({
    type: z.literal('reclaimPage'),
    previousAuthority: BrowserClientHostedPageAuthority,
    browserProfileId: Identity,
    executionHostKey: Identity,
    workspaceId: Identity.optional()
  })
)

const BrowserClientHostClosePageCommand = lazyZodSchema(() =>
  z.object({
    type: z.literal('closePage'),
    targetAuthority: BrowserClientHostedPageAuthority
  })
)

const BrowserClientHostRestorePageCommand = lazyZodSchema(() =>
  z.object({
    type: z.literal('restorePage'),
    browserProfileId: Identity,
    profile: BrowserClientProfileMetadata.optional(),
    executionHostKey: Identity,
    url: z.string().min(1).max(8192).optional(),
    workspaceId: Identity.optional()
  })
)

export const BrowserClientHostPageCommand = lazyZodSchema(() =>
  z.discriminatedUnion('type', [
    BrowserClientProfileSwitchCommand,
    BrowserClientHostCreatePageCommand,
    BrowserClientHostNavigateCommand,
    BrowserClientHostReclaimPageCommand,
    BrowserClientHostClosePageCommand,
    BrowserClientHostRestorePageCommand,
    BrowserClientAutomationCommand
  ])
)

export const BrowserClientHostCommandEvent = lazyZodSchema(() =>
  BrowserClientPageCommandAuthority.extend({
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
)

export type BrowserClientHostCommandEvent = z.infer<typeof BrowserClientHostCommandEvent>

export const BrowserClientHostCommandResultParams = lazyZodSchema(() =>
  BrowserClientPageCommandAuthority.extend({
    result: BrowserClientHostCommandResult
  })
)

export const BrowserClientHostCommandResultChunkParams = lazyZodSchema(() =>
  BrowserClientPageCommandAuthority.extend({
    offset: z.number().int().nonnegative().max(BROWSER_CLIENT_AUTOMATION_STAGED_RESULT_MAX_BYTES),
    contentBase64: z
      .string()
      .min(1)
      .max(Math.ceil(BROWSER_CLIENT_AUTOMATION_RESULT_CHUNK_MAX_BYTES / 3) * 4)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/)
  })
)

export type BrowserClientHostCommandResultChunkParams = z.infer<
  typeof BrowserClientHostCommandResultChunkParams
>

export const BrowserClientHostCommandResultAck = lazyZodSchema(() =>
  z.object({
    accepted: z.boolean()
  })
)

export const BrowserClientHostEvent = lazyZodSchema(() =>
  z.union([BrowserClientHostReady, BrowserClientHostRevoked, BrowserClientHostCommandEvent])
)

export const BrowserNetworkTunnelAttachParams = lazyZodSchema(() =>
  BrowserHostLeaseAuthority.extend({
    executionHost: BrowserNetworkExecutionHost
  })
)

export const BrowserNetworkTunnelEvent = lazyZodSchema(() =>
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('ready'),
      tunnelGeneration: Generation,
      /** Tunnel capabilities the host accepted from the attach; older hosts omit it. */
      capabilities: z.array(z.string().max(128)).max(16).optional()
    }),
    z.object({ type: z.literal('closed'), tunnelGeneration: Generation })
  ])
)
