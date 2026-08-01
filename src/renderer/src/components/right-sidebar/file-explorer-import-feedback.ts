import { translate } from '@/i18n/i18n'

type FailedFileExplorerImport = {
  reason: string
}

export type FileExplorerImportFailureToast = {
  title: string
  description?: string
}

// Why: path-bearing reasons (e.g. per-file EACCES) defeat dedup, so a large
// drop could otherwise fill the screen with one toast.
const MAX_DESCRIPTION_REASONS = 5

export function getFileExplorerImportFailureToast(
  failed: readonly FailedFileExplorerImport[]
): FileExplorerImportFailureToast {
  const noun = failed.length === 1 ? 'file' : 'files'
  const uniqueReasons = [
    ...new Set(
      failed
        // Why: reasons can embed filenames, and a newline-bearing filename would
        // both defeat the line cap and forge an extra toast line.
        .map((result) => result.reason.replace(/\s+/g, ' ').trim())
        .filter((reason) => reason.length > 0)
    )
  ]
  // Why: truncate only when it hides more than one reason — five reasons plus
  // an ellipsis line costs the same height as six plain lines.
  const reasons =
    uniqueReasons.length > MAX_DESCRIPTION_REASONS + 1
      ? [...uniqueReasons.slice(0, MAX_DESCRIPTION_REASONS), '…']
      : uniqueReasons

  return {
    title: translate(
      'auto.components.right.sidebar.useFileExplorerImport.132fd0e1e9',
      'Failed to import {{value0}} {{value1}}.',
      { value0: failed.length, value1: noun }
    ),
    // Why: import failures already carry the actionable server/staging reason;
    // hiding it behind a count makes size, permission, and SSH errors indistinguishable.
    ...(reasons.length > 0 ? { description: reasons.join('\n') } : {})
  }
}
