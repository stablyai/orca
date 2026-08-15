import { FileCode2, FileText, type LucideIcon } from 'lucide-react'
import type { ArtifactListItem } from '../../../../shared/artifacts'
import { getIntlLocale, translate } from '@/i18n/i18n'
import { formatUiRelativeTime, formatUiRelativeTimeFromDate } from '@/i18n/relative-time-format'

export function artifactName(item: ArtifactListItem): string {
  return item.artifact.title || item.artifact.originalFileName || item.artifact.slug
}

export function formatArtifactDate(value: string): string {
  return new Intl.DateTimeFormat(getIntlLocale(), {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(value))
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

export function formatArtifactUpdatedAt(value: string): string {
  return translate('auto.components.artifacts.updatedAt', 'Updated {{when}}', {
    when: formatUiRelativeTimeFromDate(
      value,
      translate('auto.components.artifacts.updatedRecently', 'recently')
    )
  })
}

/** Phrased from the stored timestamp alone — never a claim about server-side state. */
export function formatArtifactExpiry(value: string): string {
  const expiresAt = new Date(value)
  if (Number.isNaN(expiresAt.getTime())) {
    return translate('auto.components.artifacts.expiryUnknown', 'Expiry unknown')
  }
  const remainingMs = expiresAt.getTime() - Date.now()
  return remainingMs <= 0
    ? translate('auto.components.artifacts.expired', 'Link expired')
    : translate('auto.components.artifacts.expires', 'Link expires {{when}}', {
        when: formatUiRelativeTime(remainingMs)
      })
}

export function artifactTypeIcon(item: ArtifactListItem): LucideIcon {
  return item.artifact.sourceContentType === 'text/markdown' ? FileText : FileCode2
}
