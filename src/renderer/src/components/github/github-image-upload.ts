import type { GitHubAttachmentTarget } from '../../../../shared/rpc-contract/github-attachment-params'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import {
  assertGitHubImage,
  GITHUB_IMAGE_ATTACHMENT_CAPABILITY
} from '../../../../shared/github/attachments/image-attachment'
import { CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS } from '../../../../shared/rpc-contract/clipboard-params'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { getRuntimeEnvironmentRevision } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { readStoredWebRuntimeEnvironment } from '@/web/web-runtime-environment'
import { callAbortableGitHubImageUpload } from './github-image-upload-local-call'
import { blobToBase64 } from '@/lib/clipboard/images/image-blob-png'

export type GitHubImageUploadAddress = {
  runtime: RuntimeClientTarget
  target: GitHubAttachmentTarget
}

export function captureGitHubImageUpload(
  address: GitHubImageUploadAddress
): (file: File, signal?: AbortSignal) => Promise<string> {
  const target = structuredClone(address.target)
  const webEnvironment =
    isWebClientLocation() && address.runtime.kind === 'local'
      ? readStoredWebRuntimeEnvironment()
      : null
  if (isWebClientLocation() && address.runtime.kind === 'local' && !webEnvironment) {
    throw new Error('Pair this web client with an Orca server first.')
  }
  const runtime = webEnvironment
    ? { kind: 'environment' as const, environmentId: webEnvironment.id }
    : { ...address.runtime }
  const options = {
    expectedEnvironmentPairingRevision:
      runtime.kind === 'environment'
        ? getRuntimeEnvironmentRevision(runtime.environmentId)
        : undefined
  }
  const call = <T>(method: string, params?: unknown, signal?: AbortSignal) =>
    runtime.kind === 'local' && signal
      ? callAbortableGitHubImageUpload<T>(method, params, signal)
      : callRuntimeRpc<T>(runtime, method, params, { ...options, timeoutMs: 120_000, signal })
  let supported: Promise<void> | undefined
  return async (file, signal) => {
    signal?.throwIfAborted()
    assertGitHubImage(file.type, file.size)
    supported ??= call<RuntimeStatus>('status.get', undefined, signal).then((status) => {
      if (!status.capabilities?.includes(GITHUB_IMAGE_ATTACHMENT_CAPABILITY)) {
        throw new Error(
          'This Orca server cannot upload images yet. Update it, or use an image URL.'
        )
      }
    })
    await supported
    const contentBase64 = await blobToBase64(file, signal)
    signal?.throwIfAborted()
    // Keep the allocation response so retirement can release even a late staging ID.
    const { uploadId } = await call<{ uploadId: string }>('clipboard.startImageUpload', {
      expectedBase64Length: contentBase64.length,
      fileName: file.name
    })
    try {
      signal?.throwIfAborted()
      for (
        let offset = 0;
        offset < contentBase64.length;
        offset += CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS
      ) {
        await call(
          'clipboard.appendImageUploadChunk',
          {
            uploadId,
            offset,
            contentBase64: contentBase64.slice(
              offset,
              offset + CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS
            )
          },
          signal
        )
      }
      const result = await call<{ url: string }>(
        'github.uploadAttachment',
        {
          uploadId,
          target,
          fileName: file.name || 'image.png',
          contentType: file.type
        },
        signal
      )
      return result.url
    } catch (error) {
      await call('clipboard.abortImageUpload', { uploadId }).catch(() => {})
      throw error
    }
  }
}
