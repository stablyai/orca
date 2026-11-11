import { translate } from '@/i18n/i18n'

// Why: local Electron IPC has no RPC timeout; a hung git diff must become a retryable row error, not permanent "Loading...".
const COMBINED_DIFF_SECTION_LOAD_TIMEOUT_MS = 30_000

class CombinedDiffSectionLoadTimeoutError extends Error {
  constructor() {
    super('Diff did not finish loading.')
    this.name = 'CombinedDiffSectionLoadTimeoutError'
  }
}

export function withDiffSectionLoadTimeout<T>(promise: Promise<T>): Promise<T> {
  let timeoutId: number | null = null

  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(new CombinedDiffSectionLoadTimeoutError())
    }, COMBINED_DIFF_SECTION_LOAD_TIMEOUT_MS)
  })

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId)
    }
  })
}

export function getDiffSectionLoadErrorMessage(error: unknown): string {
  if (error instanceof CombinedDiffSectionLoadTimeoutError) {
    return translate(
      'auto.components.editor.CombinedDiffViewer.diffLoadTimedOut',
      'Diff did not finish loading.'
    )
  }
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : translate('auto.components.editor.CombinedDiffViewer.diffLoadFailed', 'Unable to load diff.')
}
