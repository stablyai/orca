import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export function filterLabelsValue(labels: string[], t: Translate = translate): string | null {
  if (labels.length === 0) {
    return null
  }
  if (labels.length === 1) {
    return labels[0]
  }
  return t('auto.components.github.PRFilterSections.labelCount', '{{count}} labels', {
    count: labels.length,
    defaultValue_one: '{{count}} label'
  })
}

export function filterAuthorsValue(authors: string[], t: Translate = translate): string | null {
  if (authors.length === 0) {
    return null
  }
  if (authors.length === 1) {
    return authors[0]
  }
  return t('auto.components.github.PRFilterSections.authorCount', '{{count}} authors', {
    count: authors.length,
    defaultValue_one: '{{count}} author'
  })
}
