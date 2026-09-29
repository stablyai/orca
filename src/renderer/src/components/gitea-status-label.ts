import { translate } from '@/i18n/i18n'
import type {
  GiteaMergeMethod,
  GiteaPRCheck,
  GiteaPRFileStatus,
  GiteaPullRequestDetail
} from '../../../shared/gitea-types'

export function giteaStatusLabel(
  status:
    | GiteaMergeMethod
    | GiteaPRCheck['state']
    | GiteaPRFileStatus
    | GiteaPullRequestDetail['state']
): string {
  const labels = {
    added: translate('gitea.status.added', 'Added'),
    modified: translate('gitea.status.modified', 'Modified'),
    deleted: translate('gitea.status.deleted', 'Deleted'),
    renamed: translate('gitea.status.renamed', 'Renamed'),
    copied: translate('gitea.status.copied', 'Copied'),
    changed: translate('gitea.status.changed', 'Changed'),
    open: translate('gitea.status.open', 'Open'),
    closed: translate('gitea.status.closed', 'Closed'),
    merged: translate('gitea.status.merged', 'Merged'),
    draft: translate('gitea.status.draft', 'Draft'),
    pending: translate('gitea.status.pending', 'Pending'),
    success: translate('gitea.status.success', 'Success'),
    failure: translate('gitea.status.failure', 'Failure'),
    error: translate('gitea.status.error', 'Error'),
    warning: translate('gitea.status.warning', 'Warning'),
    merge: translate('gitea.status.merge', 'Merge'),
    squash: translate('gitea.status.squash', 'Squash and merge'),
    rebase: translate('gitea.status.rebase', 'Rebase and merge')
  }
  return labels[status]
}
