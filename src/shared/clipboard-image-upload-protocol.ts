// Chunked clipboard-image upload protocol shared by the desktop main process
// and the web preload. Keeping one driver prevents the transports from
// diverging on protocol details (chunking, fallback gate, abort policy,
// connection forwarding — see #17679).

export const CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS = 512 * 1024
export const CLIPBOARD_IMAGE_SINGLE_FRAME_FALLBACK_BASE64_CHARS = 256 * 1024
export const CLIPBOARD_IMAGE_SAVE_TIMEOUT_MS = 30_000

export type ClipboardImageUploadRpcResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: { code?: string; message: string } }

export type ClipboardImageUploadRpcCall = (
  method: string,
  params: unknown,
  timeoutMs: number
) => Promise<ClipboardImageUploadRpcResponse>

async function callOk(
  call: ClipboardImageUploadRpcCall,
  method: string,
  params: unknown
): Promise<unknown> {
  const response = await call(method, params, CLIPBOARD_IMAGE_SAVE_TIMEOUT_MS)
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return response.result
}

function assertRemotePath(result: unknown): string {
  if (typeof result !== 'string') {
    throw new Error('Remote clipboard image save returned an invalid path')
  }
  return result
}

/**
 * Upload a clipboard image to the paired runtime and return the path of the
 * temp file it saved. `connectionId` names a connection owned by the RUNTIME
 * (its own SSH target for nested worktrees), never one owned by this client.
 * Falls back to the pre-chunking single-frame RPC for small images against
 * older runtimes.
 */
export async function saveClipboardImageBase64ThroughRuntime(
  call: ClipboardImageUploadRpcCall,
  contentBase64: string,
  connectionId: string | null
): Promise<string> {
  const startResponse = await call(
    'clipboard.startImageUpload',
    { expectedBase64Length: contentBase64.length, connectionId },
    CLIPBOARD_IMAGE_SAVE_TIMEOUT_MS
  )
  if (!startResponse.ok) {
    if (
      startResponse.error.code === 'method_not_found' &&
      contentBase64.length <= CLIPBOARD_IMAGE_SINGLE_FRAME_FALLBACK_BASE64_CHARS
    ) {
      return assertRemotePath(
        await callOk(call, 'clipboard.saveImageAsTempFile', { contentBase64, connectionId })
      )
    }
    throw new Error(startResponse.error.message)
  }
  const uploadId = (startResponse.result as { uploadId?: unknown } | null)?.uploadId
  if (typeof uploadId !== 'string') {
    throw new Error('Remote clipboard image upload returned an invalid id')
  }
  try {
    for (
      let offset = 0;
      offset < contentBase64.length;
      offset += CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS
    ) {
      await callOk(call, 'clipboard.appendImageUploadChunk', {
        uploadId,
        offset,
        contentBase64: contentBase64.slice(
          offset,
          offset + CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS
        )
      })
    }
    return assertRemotePath(await callOk(call, 'clipboard.commitImageUpload', { uploadId }))
  } catch (error) {
    // Why: failed chunked pastes should release the bounded remote upload slot
    // immediately instead of waiting for TTL cleanup.
    await callOk(call, 'clipboard.abortImageUpload', { uploadId }).catch(() => {})
    throw error
  }
}
