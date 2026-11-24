/** An SSH host's agent uploads its own files into, and downloads to its own disk from, desktop tabs. The desktop never reads or writes a path the host names: it pulls the named files from orcad and pushes download bytes back. */
import { z } from 'zod'
import {
  BROWSER_CLIENT_FILE_CHANNEL_CHUNK_MAX_BYTES,
  BROWSER_CLIENT_FILE_CHANNEL_TRANSFER_MAX_BYTES
} from './browser-client-file-channel-protocol'

/** Desktops without it never receive upload or download; orcad refuses those as "update the desktop". */
export const DESKTOP_BROWSER_BRIDGE_FILE_TRANSFER_CAPABILITY =
  'browser.desktopBridge.file-transfer.v1'

export const DESKTOP_BROWSER_BRIDGE_FILE_READ_METHOD = 'desktopBrowserBridge.fileRead'
export const DESKTOP_BROWSER_BRIDGE_DOWNLOAD_WRITE_METHOD = 'desktopBrowserBridge.downloadWrite'
export const DESKTOP_BROWSER_BRIDGE_DOWNLOAD_ABORT_METHOD = 'desktopBrowserBridge.downloadAbort'

const Identity = z.string().min(1).max(256)
const Offset = z.number().int().nonnegative().max(BROWSER_CLIENT_FILE_CHANNEL_TRANSFER_MAX_BYTES)

/** One piece of a file the forwarded upload command named; only that command may read it. */
export const DesktopBrowserBridgeFileReadParams = z.object({
  attachmentId: Identity,
  requestId: Identity,
  path: z.string().min(1).max(4096),
  offset: Offset,
  length: z.number().int().positive().max(BROWSER_CLIENT_FILE_CHANNEL_CHUNK_MAX_BYTES)
})
export type DesktopBrowserBridgeFileReadParams = z.infer<typeof DesktopBrowserBridgeFileReadParams>

/** A piece of the download orcad asked for by `transferId`; orcad alone knows where it goes. */
export const DesktopBrowserBridgeDownloadWriteParams = z.object({
  attachmentId: Identity,
  transferId: Identity,
  offset: Offset,
  contentBase64: z
    .string()
    .max(Math.ceil(BROWSER_CLIENT_FILE_CHANNEL_CHUNK_MAX_BYTES / 3) * 4)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  final: z.boolean()
})
export type DesktopBrowserBridgeDownloadWriteParams = z.infer<
  typeof DesktopBrowserBridgeDownloadWriteParams
>

export const DesktopBrowserBridgeDownloadWriteResult = z.object({
  accepted: z.literal(true),
  /** Only the final write names where the file was saved. */
  path: z.string().max(4096).optional()
})

export const DesktopBrowserBridgeDownloadAbortParams = z.object({
  attachmentId: Identity,
  transferId: Identity
})
export type DesktopBrowserBridgeDownloadAbortParams = z.infer<
  typeof DesktopBrowserBridgeDownloadAbortParams
>
