import type { ArtifactListItem } from '../../../../shared/artifacts/artifacts'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { formatUiRelativeTime, formatUiRelativeTimeFromDate } from '@/i18n/relative-time-format'

export function artifactName(item: ArtifactListItem): string {
  return item.artifact.title || item.artifact.originalFileName || item.artifact.slug
}

export function formatByteSize(value: number): string {
  if (value < 1024) {
    return `${value} B`
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

export function formatArtifactUpdatedAt(
  value: string,
  t: Translate = translate,
  intlLocale?: string
): string {
  return t('auto.components.artifacts.updatedAt', 'Updated {{when}}', {
    when: formatArtifactUpdatedCompact(value, t, intlLocale)
  })
}

export function formatArtifactUpdatedCompact(
  value: string,
  t: Translate = translate,
  intlLocale?: string
): string {
  return formatUiRelativeTimeFromDate(
    value,
    t('auto.components.artifacts.updatedRecently', 'recently'),
    intlLocale
  )
}

/** Phrased from the stored timestamp alone — never a claim about server-side state. */
export function formatArtifactExpiry(
  value: string,
  t: Translate = translate,
  intlLocale?: string
): string {
  const expiresAt = new Date(value)
  if (Number.isNaN(expiresAt.getTime())) {
    return t('auto.components.artifacts.expiryUnknown', 'Expiry unknown')
  }
  const remainingMs = expiresAt.getTime() - Date.now()
  return remainingMs <= 0
    ? t('auto.components.artifacts.expired', 'Link expired')
    : t('auto.components.artifacts.expires', 'Link expires {{when}}', {
        when: formatUiRelativeTime(remainingMs, intlLocale)
      })
}

export function formatArtifactExpiryCompact(
  value: string,
  t: Translate = translate,
  intlLocale?: string
): string {
  const expiresAt = new Date(value)
  if (Number.isNaN(expiresAt.getTime())) {
    return t('auto.components.artifacts.expiryUnknown', 'Expiry unknown')
  }
  const remainingMs = expiresAt.getTime() - Date.now()
  return remainingMs <= 0
    ? t('auto.components.artifacts.expiredCompact', 'Expired')
    : formatUiRelativeTime(remainingMs, intlLocale)
}

export function artifactTypeLabel(item: ArtifactListItem, t: Translate = translate): string {
  if (item.artifact.sourceContentType === 'text/markdown') {
    return t('auto.components.artifacts.typeMarkdown', 'Markdown')
  }
  if (item.artifact.sourceContentType === 'text/html') {
    return t('auto.components.artifacts.typeHtml', 'HTML')
  }
  return item.artifact.sourceContentType
}
