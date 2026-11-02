import {
  JIRA_IMAGE_MAX_BYTES,
  jiraImageReference,
  isJiraImageMimeType
} from '../../../shared/jira-attachment-image'
import { decodeJiraImageFrame } from '../../../shared/jira-image-stream-frame'
import { createBrowserUuid } from '@/lib/browser-uuid'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'
import { subscribeRuntimeEnvironment } from './runtime-environment-pairing-refresh'
import { RuntimeRpcCallError } from './runtime-rpc-result'

export async function readRuntimeJiraImage(
  target: RuntimeClientTarget,
  reference: string,
  signal: AbortSignal
): Promise<Blob> {
  if (target.kind !== 'environment') {
    throw new Error('Local Jira images use the image protocol.')
  }
  const transferId = createBrowserUuid()
  let sequence = 0
  const revision = getRuntimeEnvironmentRevision(target.environmentId)
  let close: (() => void) | undefined
  let closeWhenReady = false
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let received = 0
  let mimeType = ''
  let expected = -1
  return new Promise<Blob>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => fail(new Error('Jira image transfer timed out.')), 60_000)
    const cleanup = (): void => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      if (close) {
        close()
      } else {
        closeWhenReady = true
      }
    }
    const fail = (error: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      chunks.length = 0
      cleanup()
      reject(error)
    }
    const abort = (): void => fail(signal.reason ?? new Error('Jira image request cancelled.'))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) {
      abort()
      return
    }
    void subscribeRuntimeEnvironment(
      {
        selector: target.environmentId,
        method: 'jira.attachmentImage',
        params: { reference, transferId },
        timeoutMs: 60_000,
        expectedEnvironmentPairingRevision: revision
      },
      {
        onResponse: (response) => {
          if (settled) {
            return
          }
          if (!response.ok) {
            fail(new RuntimeRpcCallError(response))
            return
          }
          const value = response.result
          if (!value || typeof value !== 'object' || !('type' in value)) {
            fail(new Error('Invalid Jira image response.'))
            return
          }
          if (
            value.type === 'image' &&
            'mimeType' in value &&
            'byteLength' in value &&
            typeof value.mimeType === 'string' &&
            isJiraImageMimeType(value.mimeType) &&
            typeof value.byteLength === 'number' &&
            Number.isSafeInteger(value.byteLength) &&
            value.byteLength > 0 &&
            value.byteLength <= JIRA_IMAGE_MAX_BYTES &&
            expected === -1
          ) {
            mimeType = value.mimeType
            expected = value.byteLength
            return
          }
          if (value.type === 'end' && received === expected && expected > 0) {
            settled = true
            const blob = new Blob(chunks, { type: mimeType })
            chunks.length = 0
            cleanup()
            resolve(blob)
            return
          }
          fail(new Error('Jira image was invalid or incomplete.'))
        },
        onBinary: (raw) => {
          if (settled) {
            return
          }
          let frame
          try {
            frame = decodeJiraImageFrame(raw, transferId)
          } catch (error) {
            fail(error)
            return
          }
          if (!frame) {
            return
          }
          if (frame.sequence !== sequence++) {
            fail(new Error('Jira image chunks arrived out of order.'))
            return
          }
          const chunk = frame.bytes
          if (expected < 0 || chunk.byteLength === 0) {
            fail(new Error('Jira image bytes arrived before metadata.'))
            return
          }
          received += chunk.byteLength
          if (received > JIRA_IMAGE_MAX_BYTES || (expected >= 0 && received > expected)) {
            fail(new Error('Jira image exceeded its transfer limit.'))
            return
          }
          chunks.push(Uint8Array.from(chunk))
        },
        onError: fail,
        onClose: () => fail(new Error('Jira image transfer closed before completion.'))
      }
    )
      .then((handle) => {
        close = handle.unsubscribe
        if (closeWhenReady) {
          close()
        }
      })
      .catch(fail)
  })
}

export function jiraImageProtocolUrl(reference: string): string {
  const url = `orca-jira-image://attachment/${reference}`
  if (!jiraImageReference(url)) {
    throw new Error('Invalid Jira image reference.')
  }
  return url
}
