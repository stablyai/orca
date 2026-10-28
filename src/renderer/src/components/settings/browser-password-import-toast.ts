import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { BrowserPasswordImportResult } from '../../../../shared/browser-passwords-types'

export function toastBrowserPasswordImportResult(result: BrowserPasswordImportResult): void {
  if (!result.ok) {
    if (result.reason !== 'canceled') {
      toast.error(
        translate('settings.browser.passwords.importFailed', 'Could not import passwords'),
        result.message ? { description: result.message } : undefined
      )
    }
    return
  }
  const { imported, duplicates, conflicts, invalid, undecryptable } = result.summary
  const skipped = [
    duplicates > 0
      ? translate('settings.browser.passwords.importDuplicates', '{{count}} already saved', {
          count: duplicates
        })
      : null,
    conflicts > 0
      ? translate(
          'settings.browser.passwords.importConflicts',
          '{{count}} kept because a different password is saved',
          { count: conflicts }
        )
      : null,
    invalid > 0
      ? translate('settings.browser.passwords.importInvalid', '{{count}} unreadable rows', {
          count: invalid
        })
      : null,
    undecryptable > 0
      ? translate(
          'settings.browser.passwords.importUndecryptable',
          '{{count}} protected by the browser; export a CSV from it instead',
          { count: undecryptable }
        )
      : null
  ].filter((part): part is string => part !== null)
  toast.success(
    translate('settings.browser.passwords.imported', 'Imported {{count}} passwords', {
      count: imported
    }),
    skipped.length > 0 ? { description: skipped.join(' · ') } : undefined
  )
}

export function browserPasswordHostOf(origin: string): string {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}
