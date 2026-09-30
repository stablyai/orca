import type { BrowserClientAutomationMethod } from '../browser-client-automation-protocol'
import type {
  BrowserClientHostedPageInventory,
  BrowserClientHostCommandEvent,
  BrowserClientHostCommandResult,
  BrowserClientHostLeaseAuthority
} from '../browser-client-host-protocol'
import type { SubscribeBrowserHostLease } from './browser-host-lease-subscription'

export type PairedRuntimeBrowserHostLeaseOptions = {
  subscribe: SubscribeBrowserHostLease
  authorityRuntimeId: string
  browserHostClientId: string
  supportedAutomationMethods?: readonly BrowserClientAutomationMethod[]
  hostCapabilities: readonly string[]
  pageCommandProtocolVersion?: 1
  pageInventoryProtocolVersion?: 1
  pageReconciliationProtocolVersion?: 1
  leaseReconnectProtocolVersion?: 1
  fileChannelProtocolVersion?: 1
  getPageInventory?: () => readonly BrowserClientHostedPageInventory[]
  onPageCommand?: (
    command: BrowserClientHostCommandEvent
  ) => BrowserClientHostCommandResult | Promise<BrowserClientHostCommandResult>
  onAuthority?: (authority: BrowserClientHostLeaseAuthority) => void
  onTransportLost?: (error: Error) => void
  onReconnected?: (authority: BrowserClientHostLeaseAuthority) => void
  reconnectGraceMs?: number
  reconnectRetryDelayMs?: number
  maxConcurrentCommandResults?: number
  maxUnsettledCommandResults?: number
  timeoutMs?: number
  onError?: (error: Error) => void
}
