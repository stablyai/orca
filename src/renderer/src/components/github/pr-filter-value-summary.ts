import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

function filterValuesSummary(
  values: string[],
  countText: (count: number) => string
): string | null {
  return values.length > 1 ? countText(values.length) : (values[0] ?? null)
}

export function filterLabelsValue(labels: string[], t: Translate = translate): string | null {
  return filterValuesSummary(labels, (count) =>
    t('auto.components.github.PRFilterSections.labelCount', '{{count}} labels', {
      count,
      defaultValue_one: '{{count}} label'
    })
  )
}

export function filterAuthorsValue(authors: string[], t: Translate = translate): string | null {
  return filterValuesSummary(authors, (count) =>
    t('auto.components.github.PRFilterSections.authorCount', '{{count}} authors', {
      count,
      defaultValue_one: '{{count}} author'
    })
  )
}
