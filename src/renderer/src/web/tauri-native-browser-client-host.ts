import type { BrowserHostLeaseAuthority } from '../../../shared/browser/client-hosting/browser-client-host-protocol'
import {
  BrowserClientPageMetadataAck,
  type BrowserClientPageMetadataParams,
  type BrowserClientPageMetadataPublishOutcome
} from '../../../shared/browser/client-hosting/browser-client-page-metadata-protocol'
import type { RuntimeRpcResponse } from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../shared/identifiers/non-secure-context-uuid'
import { attachTauriBrowserClientHost } from './tauri-native-browser-client-host-attach'
import type { HostedPage, HostRecord } from './tauri-native-browser-client-host-page-commands'
import {
  bindTauriBrowserFileChannelClient,
  unbindTauriBrowserFileChannelClient
} from './tauri-native-browser-file-channel'

import { clearTauriBrowserClientRouteAuthority } from './tauri-native-browser-client-route-partition'
export { deriveTauriBrowserClientPartition } from './tauri-native-browser-client-route-partition'

export type TauriBrowserHostClient = {
  subscribe(
    method: string,
    params: unknown,
    callbacks: {
      onResponse: (response: RuntimeRpcResponse<unknown>) => void
      onError?: (error: { code: string; message: string }) => void
      onClose?: () => void
    },
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<{ unsubscribe: () => void }>
  call(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number }
  ): Promise<RuntimeRpcResponse<unknown>>
}

const hosts = new Map<string, HostRecord>()
const HOST_CLIENT_ID_KEY = 'orca:tauri-browser-host-client-id'
let memoryHostClientId: string | null = null

export function getTauriBrowserHostClientId(): string {
  try {
    const stored = globalThis.localStorage?.getItem(HOST_CLIENT_ID_KEY)
    if (stored && stored.length > 0) {
      return stored
    }
    const created = createBrowserUuid()
    try {
      globalThis.localStorage?.setItem(HOST_CLIENT_ID_KEY, created)
    } catch {
      memoryHostClientId = created
    }
    return created
  } catch {
    memoryHostClientId ??= createBrowserUuid()
    return memoryHostClientId
  }
}

function recordFor(environmentId: string): HostRecord | null {
  return hosts.get(environmentId) ?? null
}

export type TauriBrowserClientRouteIdentity = {
  executionHostKey: string
}

/**
 * Route identity of the client host serving `environmentId`, or null when this
 * desktop is not hosting that environment. Names the execution host a
 * settings-level cookie import applies to, mirroring Electron's
 * getPairedRuntimeBrowserClientRouteIdentity.
 *
 * Why first page: every page in one environment shares the environment's
 * execution host, and an import needs a target partition that only exists
 * once a page created it.
 */
export function getTauriBrowserClientRouteIdentity(
  environmentId: string
): TauriBrowserClientRouteIdentity | null {
  const record = recordFor(environmentId)
  if (!record || record.closed || !record.authority) {
    return null
  }
  for (const page of record.pages.values()) {
    return { executionHostKey: page.executionHostKey }
  }
  return null
}

export async function ensureTauriBrowserClientHost(options: {
  environmentId: string
  authorityRuntimeId: string
  client: TauriBrowserHostClient
}): Promise<BrowserHostLeaseAuthority> {
  const existing = recordFor(options.environmentId)
  if (
    existing &&
    !existing.closed &&
    existing.authorityRuntimeId === options.authorityRuntimeId &&
    existing.ready
  ) {
    return existing.ready
  }
  if (existing) {
    await closeTauriBrowserClientHost(options.environmentId)
  }
  const record: HostRecord = {
    environmentId: options.environmentId,
    authorityRuntimeId: options.authorityRuntimeId,
    authority: null,
    browserHostClientId: getTauriBrowserHostClientId(),
    pages: new Map(),
    subscription: null,
    abort: new AbortController(),
    ready: null,
    closed: false,
    handling: new Map()
  }
  hosts.set(options.environmentId, record)
  bindTauriBrowserFileChannelClient(options.environmentId, options.client)
  record.ready = attachTauriBrowserClientHost(record, options.client, () => {
    void closeTauriBrowserClientHost(record.environmentId)
  })
  try {
    return await record.ready
  } catch (error) {
    if (recordFor(options.environmentId) === record) {
      hosts.delete(options.environmentId)
      unbindTauriBrowserFileChannelClient(options.environmentId)
    }
    throw error
  }
}

export async function closeTauriBrowserClientHost(environmentId: string): Promise<boolean> {
  const record = recordFor(environmentId)
  if (!record) {
    return false
  }
  hosts.delete(environmentId)
  unbindTauriBrowserFileChannelClient(environmentId)
  clearTauriBrowserClientRouteAuthority(environmentId)
  record.closed = true
  record.abort?.abort()
  record.subscription?.unsubscribe()
  record.subscription = null
  return true
}

export function resetTauriBrowserClientHostsForTest(): void {
  for (const [environmentId, record] of hosts) {
    unbindTauriBrowserFileChannelClient(environmentId)
    record.abort?.abort()
    record.subscription?.unsubscribe()
  }
  hosts.clear()
}

export async function publishTauriBrowserClientPageMetadata(
  params: BrowserClientPageMetadataParams,
  client: TauriBrowserHostClient
): Promise<BrowserClientPageMetadataPublishOutcome> {
  try {
    const response = await client.call('browser.clientHost.pageMetadata', params, {
      timeoutMs: 15_000
    })
    if (!response.ok) {
      return {
        status: 'failed',
        errorCode: response.error.code || 'browser_client_page_metadata_failed'
      }
    }
    const ack = BrowserClientPageMetadataAck.safeParse(response.result)
    if (!ack.success) {
      return { status: 'failed', errorCode: 'browser_client_page_metadata_invalid' }
    }
    return { status: 'published', accepted: ack.data.accepted }
  } catch {
    return { status: 'failed', errorCode: 'browser_client_page_metadata_failed' }
  }
}

export function readTauriBrowserClientHostForTest(environmentId: string): {
  authority: BrowserHostLeaseAuthority | null
  pages: Map<string, HostedPage>
} | null {
  const record = recordFor(environmentId)
  if (!record) {
    return null
  }
  return { authority: record.authority, pages: record.pages }
}
