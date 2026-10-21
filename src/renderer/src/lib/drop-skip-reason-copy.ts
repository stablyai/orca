import { translate } from '@/i18n/i18n'
import type { ImportSkipReason } from '../../../shared/filesystem-import-result-types'

const SKIP_REASON_COPY: Record<ImportSkipReason, { key: string; fallback: string }> = {
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

/** User-facing copy for a drop skip reason; undefined for tokens outside the enum. */
export function describeDropSkipReason(reason: string): string | undefined {
  if (!isImportSkipReason(reason)) {
    return undefined
  }
  const copy = SKIP_REASON_COPY[reason]
  return translate(copy.key, copy.fallback)
}

function isImportSkipReason(reason: string): reason is ImportSkipReason {
  return Object.hasOwn(SKIP_REASON_COPY, reason)
}
