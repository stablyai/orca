import { basename } from './path'
import { translate } from '@/i18n/i18n'

export type DropUploadFailure = {
  sourcePath: string
  reason: string
}

const MAX_VISIBLE_DROP_FAILURES = 2
const FORMATTED_BYTE_COUNT = String.raw`\d+(?:\.\d+)? (?:B|KB|MB|GB|TB)`

// Why: the main-process budget errors include dynamic names and sizes, but their surrounding
// wording is a closed vocabulary; match only those shapes and never render captured details.
const REMOTE_FILE_LIMIT_REASON = new RegExp(
  String.raw`^'[^\r\n]*' is ${FORMATTED_BYTE_COUNT}, over the ${FORMATTED_BYTE_COUNT} per-file remote import limit$`
)
const REMOTE_TOTAL_LIMIT_REASON = new RegExp(
  String.raw`^This import is ${FORMATTED_BYTE_COUNT}, over the ${FORMATTED_BYTE_COUNT} total remote import limit$`
)

const SAFE_FAILURE_REASON_COPY: Readonly<Record<string, { key: string; fallback: string }>> = {
  'File is too large': {
    key: 'auto.lib.dropUploadFailure.fileTooLarge',
    fallback: 'File is too large'
  },
  missing: {
    key: 'auto.lib.dropUploadFailure.missing',
    fallback: 'File not found.'
  },
  'permission denied': {
    key: 'auto.lib.dropUploadFailure.permissionDenied',
    fallback: 'Permission denied.'
  },
  'disk full': {
    key: 'auto.lib.dropUploadFailure.storageFull',
    fallback: 'Not enough storage.'
  },
  unsupported: {
    key: 'auto.lib.dropUploadFailure.unsupported',
    fallback: 'Unsupported file type.'
  },
  'Runtime connection changed; retry the import.': {
    key: 'auto.lib.dropUploadFailure.connectionChanged',
    fallback: 'Remote connection changed; retry the import.'
  },
  'Runtime pairing changed; retry the import.': {
    key: 'auto.lib.dropUploadFailure.pairingChanged',
    fallback: 'Remote pairing changed; retry the import.'
  }
}

function formatDropUploadFailureReason(reason: string): string {
  const copy = SAFE_FAILURE_REASON_COPY[reason]
  if (copy) {
    return translate(copy.key, copy.fallback)
  }
  if (REMOTE_FILE_LIMIT_REASON.test(reason)) {
    return translate('auto.lib.dropUploadFailure.fileTooLarge', 'File is too large')
  }
  if (REMOTE_TOTAL_LIMIT_REASON.test(reason)) {
    return translate('auto.lib.dropUploadFailure.totalTooLarge', 'Total upload is too large.')
  }
  return translate('auto.lib.dropUploadFailure.generic', 'Upload failed.')
}

export function formatDropUploadFailureDescription(failed: readonly DropUploadFailure[]): string {
  const visible = failed.slice(0, MAX_VISIBLE_DROP_FAILURES).map((failure) => {
    return `${basename(failure.sourcePath)}: ${formatDropUploadFailureReason(failure.reason)}`
  })
  const hiddenCount = failed.length - visible.length
  if (hiddenCount > 0) {
    visible.push(
      translate('auto.lib.dropUploadFailure.more', '+{{count}} more failures', {
        count: hiddenCount
      })
    )
  }
  return visible.join('\n')
}
