import { translate } from '@/i18n/i18n'
import type { ImportSkipReason } from '../../../../../shared/file-import/filesystem-import-result'

type FailureCopy = { key: string; fallback: string }
type DropRejection = { status?: 'skipped' | 'failed'; reason?: string }

const SKIP_REASON_COPY: Record<ImportSkipReason, FailureCopy> = {
  missing: {
    key: 'auto.lib.dropSkipReason.missing',
    fallback: 'No longer at its original path.'
  },
  symlink: {
    key: 'auto.lib.dropSkipReason.symlink',
    fallback: 'Symbolic links cannot be attached.'
  },
  'permission-denied': {
    key: 'auto.lib.dropSkipReason.permissionDenied',
    fallback: 'Permission denied.'
  },
  unsupported: {
    key: 'auto.lib.dropSkipReason.unsupported',
    fallback: 'Unsupported file type.'
  }
}

function skipReasonCopy(reason: string | undefined): FailureCopy | undefined {
  return reason && isImportSkipReason(reason) ? SKIP_REASON_COPY[reason] : undefined
}

export function describeDropSkipReason(reason: string): string | undefined {
  const copy = skipReasonCopy(reason)
  return copy ? translate(copy.key, copy.fallback) : undefined
}

// Why: string equality rejects long host prose by length; hashing it (hasOwn, Set) scans all of it.
const SKIP_REASONS: readonly string[] = Object.keys(SKIP_REASON_COPY)

function isImportSkipReason(reason: string): reason is ImportSkipReason {
  return SKIP_REASONS.includes(reason)
}

function sharedReason(items: readonly { reason?: string }[]): string | undefined {
  const first = items[0]?.reason
  return first && items.every((item) => item.reason === first) ? first : undefined
}

export function describeSharedDropSkipReason(
  items: readonly { reason: string }[]
): string | undefined {
  const reason = sharedReason(items)
  return reason ? describeDropSkipReason(reason) : undefined
}

// Ordered: a manual disconnect also reads as a lost connection, and "too large" as a write failure.
const FAILURE_CATEGORIES: readonly (FailureCopy & { matches: RegExp })[] = [
  {
    matches: /manually disconnected|reconnect on launch is off/i,
    key: 'auto.lib.dropFailureReason.disconnected',
    fallback: 'The host is disconnected.'
  },
  {
    matches: /file_too_large|\btoo large\b|\bis larger than\b|remote import limit/i,
    key: 'auto.lib.dropFailureReason.tooLarge',
    fallback: 'Too large to upload to this host.'
  },
  {
    matches: /\bENOSPC\b|no space left|disk quota|\bEDQUOT\b/i,
    key: 'auto.lib.dropFailureReason.noSpace',
    fallback: 'The host is out of disk space.'
  },
  {
    matches: /\bEACCES\b|\bEPERM\b|\bEROFS\b|permission[ _]denied|read-only file system/i,
    key: 'auto.lib.dropSkipReason.permissionDenied',
    fallback: 'Permission denied.'
  },
  {
    matches:
      /changed during upload|changed while|changed since it was staged|truncated during upload/i,
    key: 'auto.lib.dropFailureReason.changed',
    fallback: 'The file changed while it was uploading. Try again.'
  },
  {
    matches: /\bENOENT\b|no such file/i,
    key: 'auto.lib.dropSkipReason.missing',
    fallback: 'No longer at its original path.'
  },
  {
    matches:
      /\bE(?:CONNRESET|CONNREFUSED|TIMEDOUT|PIPE|HOSTUNREACH)\b|timed out|disconnect|not connected|unreachable|\b(?:pairing|connection) changed\b/i,
    key: 'auto.lib.dropFailureReason.hostUnreachable',
    fallback: 'The connection to the host changed or dropped. Try again.'
  }
]

// Unrecognized host prose; translateFailureCopy words it by item count instead of by key.
const UNKNOWN_FAILURE: FailureCopy = { key: 'unknown', fallback: '' }

// Why: each host reason costs a regex scan, so only repeats in a row share one; more stays generic.
const MAX_CATEGORIZED_HOST_REASONS = 16

function categorizeHostReason(reason: string): FailureCopy {
  // Quoted segments are file names, which must not pick the category (`disconnect-notes.txt`).
  // Negated classes keep this linear on long paths, unlike a lazy backreference.
  const unquoted = reason.replace(/'[^'\n]*'|"[^"\n]*"|`[^`\n]*`/g, '')
  return FAILURE_CATEGORIES.find((entry) => entry.matches.test(unquoted)) ?? UNKNOWN_FAILURE
}

// Why: skip reasons are codes with their own copy; only failures carry the host's prose.
function hostReason(item: DropRejection): string | undefined {
  const { reason } = item
  return reason && item.status !== 'skipped' && !isImportSkipReason(reason) ? reason : undefined
}

function translateFailureCopy(copy: FailureCopy, itemCount: number): string {
  if (copy !== UNKNOWN_FAILURE) {
    return translate(copy.key, copy.fallback)
  }
  return itemCount === 1
    ? translate('auto.lib.dropFailureReason.unknownOne', "Couldn't upload this file.")
    : translate('auto.lib.dropFailureReason.unknownMany', "Couldn't upload these files.")
}

/** Toast detail when every rejected item falls in one category; mixed categories stay generic. */
export function describeSharedDropFailureReason(
  items: readonly DropRejection[]
): string | undefined {
  const hostReasons: string[] = []
  const copies: (FailureCopy | undefined)[] = []
  for (const item of items) {
    const reason = hostReason(item)
    if (!reason) {
      copies.push(skipReasonCopy(item.reason))
    } else if (reason !== hostReasons.at(-1)) {
      if (hostReasons.length === MAX_CATEGORIZED_HOST_REASONS) {
        return undefined
      }
      hostReasons.push(reason)
    }
  }
  if (hostReasons.length > 0) {
    // Why: host prose can quote absolute paths and toasts are often on shared screens; keep it in logs.
    console.warn('[drop] upload failed:', hostReasons)
    copies.push(...hostReasons.map(categorizeHostReason))
  }
  // Why: host prose names each file, so compare categories rather than the raw reasons.
  const [shared] = copies
  return shared && copies.every((copy) => copy?.key === shared.key)
    ? translateFailureCopy(shared, items.length)
    : undefined
}
