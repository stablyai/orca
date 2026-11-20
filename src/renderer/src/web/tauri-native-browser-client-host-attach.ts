import { BROWSER_CLIENT_AUTOMATION_HOST_CAPABILITY } from '../../../shared/browser/client-hosting/browser-client-automation-protocol'
import {
  BROWSER_CLIENT_FILE_CHANNEL_HOST_CAPABILITY,
  BROWSER_CLIENT_FILE_CHANNEL_PROTOCOL_VERSION
} from '../../../shared/browser/client-hosting/browser-client-file-channel-protocol'
import {
  BrowserClientHostEvent,
  type BrowserClientHostCommandEvent,
  type BrowserClientHostedPageInventory,
  type BrowserHostLeaseAuthority
} from '../../../shared/browser/client-hosting/browser-client-host-protocol'
import type { TauriBrowserHostClient } from './tauri-native-browser-client-host'
import {
  executeTauriBrowserClientHostPageCommand,
  sendTauriBrowserClientHostCommandResult,
  type HostRecord
} from './tauri-native-browser-client-host-page-commands'

// Attach handshake for the Tauri client host: capability advertisement and
// the per-page command queue live here so the registry in
// tauri-native-browser-client-host stays a lifecycle facade. Capability set
// mirrors Electron's paired-runtime host: webview plus the automation engine
// and file channel transport this host serves.

function snapshotInventory(record: HostRecord): BrowserClientHostedPageInventory[] {
  const authority = record.authority
  if (!authority) {
    return []
  }
  return [...record.pages.entries()].map(([browserPageId, page]) => ({
    authorityRuntimeId: authority.authorityRuntimeId,
    authorityEpoch: authority.authorityEpoch,
    browserHostClientId: authority.browserHostClientId,
    browserHostGeneration: authority.browserHostGeneration,
    browserPageId,
    pageHostGeneration: page.pageHostGeneration,
    browserProfileId: page.browserProfileId,
    executionHostKey: page.executionHostKey,
    state: 'active' as const,
    ...(page.currentUrl ? { currentUrl: page.currentUrl } : {}),
    ...(page.workspaceId ? { workspaceId: page.workspaceId } : {})
  }))
}

export async function attachTauriBrowserClientHost(
  record: HostRecord,
  client: TauriBrowserHostClient,
  onRevoked: () => void
): Promise<BrowserHostLeaseAuthority> {
  let resolveReady!: (authority: BrowserHostLeaseAuthority) => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<BrowserHostLeaseAuthority>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const timeout = setTimeout(() => {
    rejectReady(new Error('browser_client_host_attach_timeout'))
  }, 15_000)
  const subscription = await client.subscribe(
    'browser.clientHost.attach',
    {
      authorityRuntimeId: record.authorityRuntimeId,
      browserHostClientId: record.browserHostClientId,
      hostCapabilities: [
        'webview',
        BROWSER_CLIENT_AUTOMATION_HOST_CAPABILITY,
        BROWSER_CLIENT_FILE_CHANNEL_HOST_CAPABILITY
      ],
      pageCommandProtocolVersion: 1,
      pageInventoryProtocolVersion: 1,
      pageInventory: snapshotInventory(record),
      leaseReconnectProtocolVersion: 1,
      pageReconciliationProtocolVersion: 1,
      fileChannelProtocolVersion: BROWSER_CLIENT_FILE_CHANNEL_PROTOCOL_VERSION
    },
    {
      onResponse: (response) => {
        if (record.closed) {
          return
        }
        if (!response.ok) {
          return
        }
        const event = BrowserClientHostEvent.safeParse(response.result)
        if (!event.success) {
          return
        }
        if (event.data.type === 'ready') {
          if (record.authority) {
            return
          }
          const authority: BrowserHostLeaseAuthority = {
            authorityRuntimeId: record.authorityRuntimeId,
            authorityEpoch: event.data.authorityEpoch,
            browserHostClientId: record.browserHostClientId,
            browserHostGeneration: event.data.browserHostGeneration
          }
          record.authority = authority
          clearTimeout(timeout)
          resolveReady(authority)
          return
        }
        if (event.data.type === 'revoked') {
          clearTimeout(timeout)
          if (!record.authority) {
            rejectReady(new Error('browser_client_host_attach_revoked'))
          }
          onRevoked()
          return
        }
        void handleCommand(record, client, event.data)
      },
      onError: () => {
        if (!record.authority) {
          clearTimeout(timeout)
          rejectReady(new Error('browser_client_host_attach_failed'))
        }
      },
      onClose: () => {
        if (!record.authority) {
          clearTimeout(timeout)
          rejectReady(new Error('browser_client_host_attach_closed'))
        }
      }
    },
    { signal: record.abort?.signal }
  )
  if (record.closed) {
    subscription.unsubscribe()
    clearTimeout(timeout)
    throw new Error('browser_client_host_attach_closed')
  }
  record.subscription = subscription
  return ready
}

function handleCommand(
  record: HostRecord,
  client: TauriBrowserHostClient,
  event: BrowserClientHostCommandEvent
): Promise<void> {
  const key = event.browserPageId
  const previous = record.handling.get(key) ?? Promise.resolve()
  const next = previous
    .catch(() => {})
    .then(() => executeTauriBrowserClientHostPageCommand(record, event))
    .then((result) => sendTauriBrowserClientHostCommandResult(client, event, result))
    .catch(() => {})
  record.handling.set(key, next)
  void next.then(() => {
    if (record.handling.get(key) === next) {
      record.handling.delete(key)
    }
  })
  return next
}
