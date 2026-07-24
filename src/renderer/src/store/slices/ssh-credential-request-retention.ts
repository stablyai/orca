import { clampUtf8TextPrefix, measureUtf8ByteLength } from '../../../../shared/utf8-byte-limits'
import {
  SSH_CREDENTIAL_DETAIL_MAX_UTF8_BYTES,
  SSH_RETAINED_IDENTIFIER_MAX_UTF8_BYTES
} from '../../../../shared/ssh-retained-payload-admission'

export type SshCredentialRequest = {
  requestId: string
  targetId: string
  kind: 'passphrase' | 'password'
  detail: string
}

export type SshCredentialRequestRetentionBounds = {
  maxRequests: number
  maxRequestIdBytes: number
  maxTargetIdBytes: number
  maxDetailBytes: number
}

export const DEFAULT_SSH_CREDENTIAL_REQUEST_RETENTION_BOUNDS: SshCredentialRequestRetentionBounds =
  {
    maxRequests: 64,
    maxRequestIdBytes: 1024,
    maxTargetIdBytes: SSH_RETAINED_IDENTIFIER_MAX_UTF8_BYTES,
    maxDetailBytes: SSH_CREDENTIAL_DETAIL_MAX_UTF8_BYTES
  }

export type SshCredentialRequestRetentionNotice =
  | {
      action: 'dropped'
      reason: 'duplicate-request-id' | 'queue-full' | 'oversized-request-id' | 'oversized-target-id'
      limit: number
    }
  | {
      action: 'truncated'
      field: 'detail'
      limit: number
    }

export type SshCredentialRequestRetentionResult = {
  queue: SshCredentialRequest[]
  notice?: SshCredentialRequestRetentionNotice
}

export function retainSshCredentialRequest(
  queue: SshCredentialRequest[],
  request: SshCredentialRequest,
  bounds: SshCredentialRequestRetentionBounds = DEFAULT_SSH_CREDENTIAL_REQUEST_RETENTION_BOUNDS
): SshCredentialRequestRetentionResult {
  if (queue.some((entry) => entry.requestId === request.requestId)) {
    return {
      queue,
      notice: {
        action: 'dropped',
        reason: 'duplicate-request-id',
        limit: bounds.maxRequests
      }
    }
  }
  if (
    measureUtf8ByteLength(request.requestId, {
      stopAfterBytes: bounds.maxRequestIdBytes
    }).exceededLimit
  ) {
    return {
      queue,
      notice: {
        action: 'dropped',
        reason: 'oversized-request-id',
        limit: bounds.maxRequestIdBytes
      }
    }
  }
  if (
    measureUtf8ByteLength(request.targetId, {
      stopAfterBytes: bounds.maxTargetIdBytes
    }).exceededLimit
  ) {
    return {
      queue,
      notice: {
        action: 'dropped',
        reason: 'oversized-target-id',
        limit: bounds.maxTargetIdBytes
      }
    }
  }
  if (queue.length >= bounds.maxRequests) {
    return {
      queue,
      notice: {
        action: 'dropped',
        reason: 'queue-full',
        limit: bounds.maxRequests
      }
    }
  }

  const boundedDetail = clampUtf8TextPrefix(request.detail, bounds.maxDetailBytes)
  return {
    queue: [
      ...queue,
      {
        ...request,
        detail: boundedDetail
      }
    ],
    ...(boundedDetail !== request.detail
      ? {
          notice: {
            action: 'truncated' as const,
            field: 'detail' as const,
            limit: bounds.maxDetailBytes
          }
        }
      : {})
  }
}
