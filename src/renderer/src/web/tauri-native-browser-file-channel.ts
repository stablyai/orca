import { createNonSecureContextUuid as createBrowserUuid } from '../../../shared/identifiers/non-secure-context-uuid'
import {
  BROWSER_CLIENT_FILE_CHANNEL_CHUNK_MAX_BYTES,
  BrowserClientFileChannelReadResult,
  BrowserClientFileChannelWriteResult
} from '../../../shared/browser/client-hosting/browser-client-file-channel-protocol'
import type { BrowserHostLeaseAuthority } from '../../../shared/browser/client-hosting/browser-client-host-protocol'
import { listenNative } from './tauri-native-host'
import type { TauriBrowserHostClient } from './tauri-native-browser-client-host'

export const TAURI_FILE_CHANNEL_READ_METHOD = 'browser.clientHost.fileChannel.read'
export const TAURI_FILE_CHANNEL_WRITE_METHOD = 'browser.clientHost.fileChannel.write'
export const TAURI_FILE_CHANNEL_ABORT_METHOD = 'browser.clientHost.fileChannel.abort'
const FILE_CHANNEL_REQUEST_TIMEOUT_MS = 30_000
const DOWNLOAD_FINISH_TIMEOUT_MS = 60_000

export type TauriFileChannelAuthority = {
  authority: BrowserHostLeaseAuthority
  browserPageId: string
  pageHostGeneration: number
}

const channelClients = new Map<string, TauriBrowserHostClient>()

export function bindTauriBrowserFileChannelClient(
  environmentId: string,
  client: TauriBrowserHostClient
): void {
  channelClients.set(environmentId, client)
}

export function unbindTauriBrowserFileChannelClient(environmentId: string): void {
  channelClients.delete(environmentId)
}

export function getTauriBrowserFileChannelClient(
  environmentId: string
): TauriBrowserHostClient | null {
  return channelClients.get(environmentId) ?? null
}

export function createFileChannelTransferId(): string {
  return createBrowserUuid()
}

function authorityParams(route: TauriFileChannelAuthority): Record<string, unknown> {
  return {
    fileChannelProtocolVersion: 1,
    authorityRuntimeId: route.authority.authorityRuntimeId,
    authorityEpoch: route.authority.authorityEpoch,
    browserHostClientId: route.authority.browserHostClientId,
    browserHostGeneration: route.authority.browserHostGeneration,
    browserPageId: route.browserPageId,
    pageHostGeneration: route.pageHostGeneration
  }
}

export async function callTauriBrowserFileChannel(
  client: TauriBrowserHostClient,
  route: TauriFileChannelAuthority,
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const response = await client
    .call(
      method,
      { ...authorityParams(route), ...params },
      { timeoutMs: FILE_CHANNEL_REQUEST_TIMEOUT_MS }
    )
    .catch(() => {
      throw new Error('browser_client_file_channel_failed')
    })
  if (!response.ok) {
    throw new Error(response.error.code || 'browser_client_file_channel_failed')
  }
  return response.result
}

export async function readTauriFileChannelChunk(
  client: TauriBrowserHostClient,
  route: TauriFileChannelAuthority,
  workspaceRelativePath: string,
  offset: number
): Promise<{ contentBase64: string; bytesRead: number; eof: boolean; totalBytes: number }> {
  const result = await callTauriBrowserFileChannel(client, route, TAURI_FILE_CHANNEL_READ_METHOD, {
    workspaceRelativePath,
    offset,
    length: BROWSER_CLIENT_FILE_CHANNEL_CHUNK_MAX_BYTES
  })
  const parsed = BrowserClientFileChannelReadResult.safeParse(result)
  if (!parsed.success) {
    throw new Error('browser_client_file_channel_chunk_rejected')
  }
  return {
    contentBase64: parsed.data.contentBase64,
    bytesRead: parsed.data.bytesRead,
    eof: parsed.data.eof,
    totalBytes: parsed.data.totalBytes
  }
}

export async function writeTauriFileChannelChunk(
  client: TauriBrowserHostClient,
  route: TauriFileChannelAuthority,
  chunk: {
    transferId: string
    filename: string
    contentBase64: string
    offset: number
    final: boolean
  }
): Promise<string | null> {
  const result = await callTauriBrowserFileChannel(client, route, TAURI_FILE_CHANNEL_WRITE_METHOD, {
    transferId: chunk.transferId,
    filename: chunk.filename,
    contentBase64: chunk.contentBase64,
    offset: chunk.offset,
    final: chunk.final
  })
  const parsed = BrowserClientFileChannelWriteResult.safeParse(result)
  if (!parsed.success || parsed.data.accepted !== true) {
    throw new Error('browser_client_file_channel_chunk_rejected')
  }
  return parsed.data.workspaceRelativePath ?? null
}

export async function abortTauriFileChannelTransfer(
  client: TauriBrowserHostClient,
  route: TauriFileChannelAuthority,
  transferId: string
): Promise<void> {
  await callTauriBrowserFileChannel(client, route, TAURI_FILE_CHANNEL_ABORT_METHOD, {
    transferId
  }).catch(() => {})
}

type TauriDownloadFinishedEvent = {
  browserPageId?: string
  downloadId?: string
  status?: string
  savePath?: string | null
  save_path?: string | null
  error?: string | null
}

type PendingDownload = {
  resolve: (value: { savePath: string; downloadId: string }) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const pendingDownloads = new Map<string, PendingDownload>()
let downloadListenerInstalled = false

function ensureDownloadListener(): void {
  if (downloadListenerInstalled) {
    return
  }
  downloadListenerInstalled = true
  listenNative<TauriDownloadFinishedEvent>('browser:download-finished', (event) => {
    const browserPageId = event.browserPageId
    if (!browserPageId) {
      return
    }
    const pending = pendingDownloads.get(browserPageId)
    if (!pending) {
      return
    }
    pendingDownloads.delete(browserPageId)
    clearTimeout(pending.timer)
    const savePath = event.savePath ?? event.save_path ?? null
    if (event.status === 'completed' && savePath) {
      pending.resolve({ savePath, downloadId: event.downloadId ?? '' })
      return
    }
    pending.reject(new Error('browser_client_download_failed'))
  })
}

export function awaitTauriBrowserDownload(
  browserPageId: string,
  timeoutMs: number = DOWNLOAD_FINISH_TIMEOUT_MS
): Promise<{ savePath: string; downloadId: string }> {
  ensureDownloadListener()
  const previous = pendingDownloads.get(browserPageId)
  if (previous) {
    pendingDownloads.delete(browserPageId)
    clearTimeout(previous.timer)
    previous.reject(new Error('browser_client_download_superseded'))
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pendingDownloads.get(browserPageId)?.reject === reject) {
        pendingDownloads.delete(browserPageId)
      }
      reject(new Error('browser_timeout'))
    }, timeoutMs)
    pendingDownloads.set(browserPageId, { resolve, reject, timer })
  })
}

export function resetTauriBrowserFileChannelForTest(): void {
  channelClients.clear()
  for (const pending of pendingDownloads.values()) {
    clearTimeout(pending.timer)
  }
  pendingDownloads.clear()
}
