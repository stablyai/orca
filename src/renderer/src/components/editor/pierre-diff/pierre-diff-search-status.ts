import { translate } from '@/i18n/i18n'
import type { DiffSearchError } from './pierre-diff-search'

export function translateDiffSearchError(error: DiffSearchError): string {
  switch (error) {
    case 'invalid-regex':
      return translate('editor.diff.search.errors.invalid-regex', 'Invalid regular expression')
    case 'replacement-too-large':
      return translate(
        'editor.diff.search.errors.replacement-too-large',
        'Replacement is too large'
      )
    case 'search-failed':
      return translate('editor.diff.search.errors.search-failed', 'Could not search this file')
    case 'invalid-result':
      return translate('editor.diff.search.errors.invalid-result', 'Could not read search results')
    case 'timeout':
      return translate(
        'editor.diff.search.errors.timeout',
        'Search took too long. Try a simpler expression.'
      )
    case 'start-failed':
      return translate('editor.diff.search.errors.start-failed', 'Could not start search')
  }
}
