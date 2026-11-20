import {
  BROWSER_CLIENT_FILE_CHANNEL_CHUNK_MAX_BYTES,
  BROWSER_CLIENT_FILE_CHANNEL_MAX_FILES_PER_COMMAND,
  BROWSER_CLIENT_FILE_CHANNEL_TRANSFER_MAX_BYTES
} from '../../../shared/browser/client-hosting/browser-client-file-channel-protocol'
import { invokeNative } from './tauri-native-host'
import type { AutomationCommandContext, TauriCdpSender } from './tauri-native-browser-automation'
import {
  evaluatePageExpression,
  isRecord,
  resolveAutomationRef,
  resolveElementObjectId
} from './tauri-native-browser-automation'
import { dispatchMouse } from './tauri-native-browser-automation-pointer'
import { senderForAutomationEntry } from './tauri-native-browser-iframe-sessions'
import type { TauriBrowserHostClient } from './tauri-native-browser-client-host'
import {
  abortTauriFileChannelTransfer,
  awaitTauriBrowserDownload,
  createFileChannelTransferId,
  readTauriFileChannelChunk,
  writeTauriFileChannelChunk,
  type TauriFileChannelAuthority
} from './tauri-native-browser-file-channel'

function basenameOf(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const parts = normalized.split('/')
  return parts.at(-1) ?? path
}

type StagedUpload = { uploadId: string; stagingPath: string; totalBytes: number }

async function stageUploadChunk(
  uploadId: string | null,
  filename: string,
  contentBase64: string,
  finalChunk: boolean
): Promise<{ uploadId: string; stagingPath: string | null }> {
  const args: Record<string, unknown> = { filename, contentBase64, finalChunk }
  if (uploadId) {
    args.uploadId = uploadId
  }
  const result = await invokeNative<unknown>('poc_browser_stage_upload_chunk', { args }).catch(
    () => {
      throw new Error('browser_cdp_error')
    }
  )
  if (!isRecord(result) || typeof result.uploadId !== 'string') {
    throw new Error('browser_cdp_error')
  }
  const stagingPath = result.stagingPath
  if (finalChunk && typeof stagingPath !== 'string') {
    throw new Error('browser_cdp_error')
  }
  return {
    uploadId: result.uploadId,
    stagingPath: typeof stagingPath === 'string' ? stagingPath : null
  }
}

async function discardStagedUpload(uploadId: string): Promise<void> {
  // Bare-param command: the Rust side takes upload_id directly, not an
  // args struct, so a wrapped payload is rejected and staging dirs leak.
  await invokeNative<unknown>('poc_browser_discard_staged_upload', { uploadId }).catch(() => {})
}

async function pullRemoteFileToStaging(
  client: TauriBrowserHostClient,
  route: TauriFileChannelAuthority,
  workspaceRelativePath: string
): Promise<StagedUpload> {
  if (!workspaceRelativePath) {
    throw new Error('browser_invalid_params')
  }
  const filename = basenameOf(workspaceRelativePath) || 'upload'
  let uploadId: string | null = null
  let stagingPath: string | null = null
  let offset = 0
  try {
    for (;;) {
      const chunk = await readTauriFileChannelChunk(client, route, workspaceRelativePath, offset)
      if (offset + chunk.bytesRead > BROWSER_CLIENT_FILE_CHANNEL_TRANSFER_MAX_BYTES) {
        throw new Error('browser_client_upload_too_large')
      }
      const staged = await stageUploadChunk(uploadId, filename, chunk.contentBase64, chunk.eof)
      uploadId = staged.uploadId
      offset += chunk.bytesRead
      if (chunk.eof) {
        stagingPath = staged.stagingPath
        break
      }
      if (chunk.bytesRead === 0) {
        throw new Error('browser_client_file_channel_failed')
      }
    }
  } catch (error) {
    if (uploadId) {
      await discardStagedUpload(uploadId)
    }
    throw error
  }
  if (!uploadId || !stagingPath) {
    if (uploadId) {
      await discardStagedUpload(uploadId)
    }
    throw new Error('browser_client_file_channel_failed')
  }
  return { uploadId, stagingPath, totalBytes: offset }
}

export async function uploadTauriBrowserFiles(
  client: TauriBrowserHostClient,
  route: TauriFileChannelAuthority,
  context: AutomationCommandContext,
  element: string,
  files: unknown
): Promise<{ uploaded: number }> {
  if (
    !Array.isArray(files) ||
    files.length === 0 ||
    files.length > BROWSER_CLIENT_FILE_CHANNEL_MAX_FILES_PER_COMMAND
  ) {
    throw new Error('browser_invalid_params')
  }
  const paths: string[] = []
  for (const file of files) {
    if (typeof file !== 'string' || file.length === 0) {
      throw new Error('browser_invalid_params')
    }
    paths.push(file)
  }
  const entry = resolveAutomationRef(context.refs, element)
  const send = senderForAutomationEntry(context, entry)
  const objectId = await resolveElementObjectId(send, entry)
  const staged: StagedUpload[] = []
  let stagedBytes = 0
  try {
    for (const workspaceRelativePath of paths) {
      const pulled = await pullRemoteFileToStaging(client, route, workspaceRelativePath)
      staged.push(pulled)
      stagedBytes += pulled.totalBytes
      if (stagedBytes > BROWSER_CLIENT_FILE_CHANNEL_TRANSFER_MAX_BYTES) {
        throw new Error('browser_client_upload_too_large')
      }
    }
    await send('DOM.setFileInputFiles', {
      objectId,
      files: staged.map((item) => item.stagingPath)
    }).catch(() => {
      throw new Error('browser_element_not_interactable')
    })
  } finally {
    for (const item of staged) {
      await discardStagedUpload(item.uploadId)
    }
  }
  return { uploaded: files.length }
}

async function selectorCenter(
  send: TauriCdpSender,
  selector: string
): Promise<{ x: number; y: number } | null> {
  const center = await evaluatePageExpression(
    send,
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const rect = el.getBoundingClientRect(); if (rect.width === 0 || rect.height === 0) return null; return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; })()`
  ).catch(() => null)
  if (!isRecord(center) || typeof center.x !== 'number' || typeof center.y !== 'number') {
    return null
  }
  return { x: center.x, y: center.y }
}

type RelayChunk = { contentBase64: string; bytesRead: number; eof: boolean }

async function relayDownloadChunk(savePath: string, offset: number): Promise<RelayChunk> {
  const result = await invokeNative<unknown>('poc_browser_relay_download_chunk', {
    args: { savePath, offset, length: BROWSER_CLIENT_FILE_CHANNEL_CHUNK_MAX_BYTES }
  }).catch(() => {
    throw new Error('browser_cdp_error')
  })
  if (
    !isRecord(result) ||
    typeof result.contentBase64 !== 'string' ||
    typeof result.bytesRead !== 'number' ||
    typeof result.eof !== 'boolean'
  ) {
    throw new Error('browser_cdp_error')
  }
  return { contentBase64: result.contentBase64, bytesRead: result.bytesRead, eof: result.eof }
}

async function cleanupRelayedDownload(savePath: string): Promise<void> {
  // Bare-param command like discard above: save_path travels unwrapped.
  await invokeNative<unknown>('poc_browser_cleanup_relayed_download', { savePath }).catch(() => {})
}

export async function downloadTauriBrowserFile(
  client: TauriBrowserHostClient,
  route: TauriFileChannelAuthority,
  send: TauriCdpSender,
  selector: string,
  remotePath: unknown
): Promise<{ downloaded: boolean; path: string }> {
  if (!selector || typeof remotePath !== 'string' || !remotePath) {
    throw new Error('browser_invalid_params')
  }
  const center = await selectorCenter(send, selector)
  if (!center) {
    throw new Error('browser_ref_not_found')
  }
  const pending = awaitTauriBrowserDownload(route.browserPageId)
  await dispatchMouse(send, 'mousePressed', center, { buttons: 1 })
  await dispatchMouse(send, 'mouseReleased', center)
  const finished = await pending
  const filename = basenameOf(remotePath) || basenameOf(finished.savePath) || 'download'
  const transferId = createFileChannelTransferId()
  try {
    let offset = 0
    let workspaceRelativePath: string | null = null
    for (;;) {
      const chunk = await relayDownloadChunk(finished.savePath, offset)
      if (offset + chunk.bytesRead > BROWSER_CLIENT_FILE_CHANNEL_TRANSFER_MAX_BYTES) {
        throw new Error('browser_client_download_too_large')
      }
      const committed = await writeTauriFileChannelChunk(client, route, {
        transferId,
        filename,
        contentBase64: chunk.contentBase64,
        offset,
        final: chunk.eof
      })
      offset += chunk.bytesRead
      if (chunk.eof) {
        workspaceRelativePath = committed
        break
      }
      if (chunk.bytesRead === 0) {
        throw new Error('browser_client_file_channel_failed')
      }
    }
    if (!workspaceRelativePath) {
      throw new Error('browser_client_download_destination_missing')
    }
    await cleanupRelayedDownload(finished.savePath)
    return { downloaded: true, path: workspaceRelativePath }
  } catch (error) {
    await abortTauriFileChannelTransfer(client, route, transferId)
    await cleanupRelayedDownload(finished.savePath)
    throw error
  }
}
