import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { ConfirmationDialogOptions } from '@/components/confirmation-dialog-context'
import type { SearchResult } from '../../../../shared/code-search-types'
import type { SearchReplaceSummary } from './search-replace-files'

export function occurrencesLabel(count: number): string {
  return translate(
    'auto.components.right.sidebar.SearchReplace.occurrences',
    '{{count}} occurrences',
    {
      count
    }
  )
}

export function filesLabel(count: number): string {
  return translate('auto.components.right.sidebar.SearchReplace.files', '{{count}} files', {
    count
  })
}

const MAX_LISTED_PATHS = 10

function listPaths(lines: readonly string[]): string {
  if (lines.length <= MAX_LISTED_PATHS) {
    return lines.join('\n')
  }
  const more = translate(
    'auto.components.right.sidebar.SearchReplace.andMore',
    '…and {{count}} more',
    {
      count: lines.length - MAX_LISTED_PATHS
    }
  )
  return [...lines.slice(0, MAX_LISTED_PATHS), more].join('\n')
}

export function reportSearchReplaceSummary(
  summary: SearchReplaceSummary,
  replaceText: string,
  announce: boolean
): void {
  if (announce && summary.replacedCount > 0) {
    toast.success(
      replaceText
        ? translate(
            'auto.components.right.sidebar.SearchReplace.replacedWith',
            "Replaced {{occurrences}} across {{files}} with '{{replaceText}}'.",
            {
              occurrences: occurrencesLabel(summary.replacedCount),
              files: filesLabel(summary.replacedFiles),
              replaceText
            }
          )
        : translate(
            'auto.components.right.sidebar.SearchReplace.replaced',
            'Replaced {{occurrences}} across {{files}}.',
            {
              occurrences: occurrencesLabel(summary.replacedCount),
              files: filesLabel(summary.replacedFiles)
            }
          )
    )
  }
  if (summary.dirtyFiles.length > 0) {
    toast.warning(
      translate(
        'auto.components.right.sidebar.SearchReplace.skippedDirty',
        'Skipped {{files}} with unsaved changes. Save them, then replace again.',
        { files: filesLabel(summary.dirtyFiles.length) }
      ),
      { description: listPaths(summary.dirtyFiles) }
    )
  }
  if (summary.staleFiles.length > 0) {
    toast.warning(
      translate(
        'auto.components.right.sidebar.SearchReplace.skippedStale',
        'Skipped {{files}} that no longer match the search results. Check the refreshed results, then replace again.',
        { files: filesLabel(summary.staleFiles.length) }
      ),
      { description: listPaths(summary.staleFiles) }
    )
  }
  if (summary.notUtf8Files.length > 0) {
    toast.warning(
      translate(
        'auto.components.right.sidebar.SearchReplace.skippedNotUtf8',
        'Skipped {{files}} that are not UTF-8 text.',
        { files: filesLabel(summary.notUtf8Files.length) }
      ),
      { description: listPaths(summary.notUtf8Files) }
    )
  }
  if (summary.failures.length > 0) {
    toast.error(
      translate(
        'auto.components.right.sidebar.SearchReplace.failed',
        'Could not replace in {{files}}.',
        { files: filesLabel(summary.failures.length) }
      ),
      {
        description: listPaths(
          summary.failures.map((failure) => `${failure.relativePath}: ${failure.message}`)
        )
      }
    )
  }
}

export function searchReplaceAllConfirmation(
  results: SearchResult,
  replaceText: string
): ConfirmationDialogOptions {
  // Why: replace writes only the listed matches, which can be fewer than totalMatches.
  const listedMatches = results.files.reduce((sum, file) => sum + file.matches.length, 0)
  const occurrences = occurrencesLabel(listedMatches)
  const files = filesLabel(results.files.length)
  return {
    title: replaceText
      ? translate(
          'auto.components.right.sidebar.SearchReplace.confirmWith',
          "Replace {{occurrences}} across {{files}} with '{{replaceText}}'?",
          { occurrences, files, replaceText }
        )
      : translate(
          'auto.components.right.sidebar.SearchReplace.confirm',
          'Replace {{occurrences}} across {{files}}?',
          { occurrences, files }
        ),
    description: results.truncated
      ? translate(
          'auto.components.right.sidebar.SearchReplace.confirmTruncated',
          'Results were truncated. Only the matches listed are changed.'
        )
      : undefined,
    confirmLabel: translate('auto.components.right.sidebar.SearchReplace.replace', 'Replace'),
    initialFocus: 'confirm'
  }
}
