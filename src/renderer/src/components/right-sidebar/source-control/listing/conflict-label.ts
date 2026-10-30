import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import { Check, FileCheck, FileX, type LucideIcon } from 'lucide-react'
import type { ConflictResolution } from '../../../../../../shared/source-control-entry-actions'
import { translate } from '@/i18n/i18n'

/** Localized short label for a merge-conflict kind, e.g. `both_modified` → "both modified". */
export function getLocalizedConflictKindLabel(
  kind: NonNullable<GitStatusEntry['conflictKind']>
): string {
  switch (kind) {
    case 'both_modified':
      return translate('auto.components.right.sidebar.SourceControl.c569d29a02', 'both modified')
    case 'both_added':
      return translate('auto.components.right.sidebar.SourceControl.ea7287d84f', 'both added')
    case 'deleted_by_us':
      return translate('auto.components.right.sidebar.SourceControl.bd0151ef7b', 'deleted by us')
    case 'deleted_by_them':
      return translate('auto.components.right.sidebar.SourceControl.44594e8c61', 'deleted by them')
    case 'added_by_us':
      return translate('auto.components.right.sidebar.SourceControl.24773ee581', 'added by us')
    case 'added_by_them':
      return translate('auto.components.right.sidebar.SourceControl.c03d7c952f', 'added by them')
    case 'both_deleted':
      return translate('auto.components.right.sidebar.SourceControl.5b176fa431', 'both deleted')
  }
}

export const CONFLICT_RESOLUTION_ICONS: Record<ConflictResolution, LucideIcon> = {
  mark_resolved: Check,
  keep_file: FileCheck,
  keep_deletion: FileX
}

export function getLocalizedConflictResolutionLabel(resolution: ConflictResolution): string {
  switch (resolution) {
    case 'mark_resolved':
      return translate(
        'auto.components.right.sidebar.SourceControl.markResolved',
        'Mark as resolved'
      )
    case 'keep_file':
      return translate('auto.components.right.sidebar.SourceControl.keepFile', 'Keep file')
    case 'keep_deletion':
      return translate('auto.components.right.sidebar.SourceControl.keepDeletion', 'Keep deletion')
  }
}
