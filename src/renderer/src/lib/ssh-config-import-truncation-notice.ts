import type { SshConfigTruncationReason } from '../../../shared/ssh-types'
import { translate } from '../i18n/i18n'

const REASON_COPY: Record<SshConfigTruncationReason, { key: string; fallback: string }> = {
  'expanded-output': {
    key: 'lib.sshConfigImportTruncation.expandedOutput',
    fallback: 'it is too large'
  },
  'file-bytes': {
    key: 'lib.sshConfigImportTruncation.fileBytes',
    fallback: 'an included file is too large'
  },
  'file-count': {
    key: 'lib.sshConfigImportTruncation.fileCount',
    fallback: 'it includes too many files'
  },
  'glob-matches': {
    key: 'lib.sshConfigImportTruncation.globMatches',
    fallback: 'an include pattern matched too many files'
  },
  'nesting-depth': {
    key: 'lib.sshConfigImportTruncation.nestingDepth',
    fallback: 'its includes nest too deeply'
  },
  'source-bytes': {
    key: 'lib.sshConfigImportTruncation.sourceBytes',
    fallback: 'its included files total too much data'
  }
}

/**
 * Warning text for an import that hit an include ceiling, or null when nothing was
 * dropped. Without this the user sees a plain success toast for a partial import and
 * has no way to tell that a host is missing rather than absent from the file.
 */
export function getSshConfigImportTruncationNotice(
  truncatedBy: readonly SshConfigTruncationReason[] | null | undefined
): string | null {
  if (!truncatedBy || truncatedBy.length === 0) {
    return null
  }
  const reasons = truncatedBy
    .filter((reason) => reason in REASON_COPY)
    .map((reason) => translate(REASON_COPY[reason].key, REASON_COPY[reason].fallback))
  if (reasons.length === 0) {
    return null
  }
  return translate(
    'lib.sshConfigImportTruncation.summary',
    'Some hosts were skipped because {{reasons}}. Imported hosts may be incomplete.',
    { reasons: reasons.join('; ') }
  )
}

/**
 * Which toast an import should raise. A partial import outranks the success and
 * already-in-sync reports: those tell the user everything landed, which is false
 * whenever a ceiling dropped part of the config.
 */
export function getSshConfigImportOutcome(result: {
  targets: readonly unknown[]
  truncatedBy?: readonly SshConfigTruncationReason[] | null
}): { kind: 'truncated'; message: string } | { kind: 'in-sync' } | { kind: 'synced' } {
  const message = getSshConfigImportTruncationNotice(result.truncatedBy)
  if (message) {
    return { kind: 'truncated', message }
  }
  return result.targets.length === 0 ? { kind: 'in-sync' } : { kind: 'synced' }
}
