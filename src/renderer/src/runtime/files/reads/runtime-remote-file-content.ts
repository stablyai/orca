import type { RuntimeFileReadResult } from '../../../../../shared/runtime-file-contracts'
import { BINARY_PROBE_BYTES } from '../../../../../shared/binary-buffer'
import { remoteFileRequest } from '../../../../../shared/remote-file-locator'
import type { RuntimeReadableFileContent } from '../runtime-file-client-types'
import type { RuntimeRemoteFileAddress } from './runtime-file-range-client'
import { readRemoteRangePreview } from './runtime-file-range-preview'
import {
  pagedTextFileResult,
  pinRemoteFileAddress,
  readRemoteBinaryFile,
  readRemoteFileInChunks
} from './runtime-paged-file-read'
import { callRuntimeRpc } from '../../runtime-rpc-client'
import { RuntimeRpcCallError } from '../../runtime-rpc-result'

function isRpcRefusal(error: unknown, message: string): boolean {
  return error instanceof RuntimeRpcCallError && error.message === message
}

/** A paired runtime's file for the editor: streamed to a viewer by URL, previewed, or paged past one reply. */
export async function readRemoteFileContent(
  address: RuntimeRemoteFileAddress,
  { pageOversizedBinary }: { pageOversizedBinary: boolean }
): Promise<RuntimeReadableFileContent> {
  const remote = pinRemoteFileAddress(address)
  // Baseline checks discard binary content, so only readers that render bytes mint a stream.
  const rangePreview = pageOversizedBinary ? await readRemoteRangePreview(remote) : null
  if (rangePreview) {
    return rangePreview
  }
  const { method, params } = remoteFileRequest(remote.worktree, remote, 'read')
  let result: RuntimeFileReadResult | null
  try {
    result = await callRuntimeRpc<RuntimeFileReadResult>(remote.target, method, params, {
      timeoutMs: 15_000,
      expectedEnvironmentPairingRevision: remote.expectedEnvironmentPairingRevision
    })
  } catch (err) {
    // Typed binary_file refusal permits base64 preview for PDFs/images; unrelated errors cannot spoof this fallback.
    if (isRpcRefusal(err, 'binary_file')) {
      // Why: baseline checks call this too and discard binary content, so paging is opt-in.
      return readRemoteBinaryFile(remote, { pageOversized: pageOversizedBinary })
    }
    // Why: a granted file past one reply is refused whole rather than cut short.
    if (remote.grantId === undefined || !isRpcRefusal(err, 'file_too_large')) {
      throw err
    }
    result = null
  }
  // Hosts before content sniffing send an unlisted binary as text; NUL is git's binary signal.
  if (result?.content.slice(0, BINARY_PROBE_BYTES).includes('\0')) {
    return { content: '', isBinary: true }
  }
  if (!result || result.truncated) {
    // Replies stop at 512KiB; page the whole file or later editable saves truncate it.
    const paged = await readRemoteFileInChunks(remote)
    if (paged.kind === 'ok') {
      return pagedTextFileResult(paged.bytes)
    }
    throw new Error(
      paged.kind === 'unsupported'
        ? 'Remote file is larger than the 512 KB this Orca server can send. Update the server to open it.'
        : `Remote file is too large to open in the editor (${paged.size} bytes)`
    )
  }
  return { content: result.content, isBinary: false }
}
