import { translate } from '@/i18n/i18n'

export function attentionNotificationLabel(kind: string): string {
  switch (kind) {
    case 'IssueNotification':
      return translate('linear.attention.kind.issue', 'Issue')
    case 'ProjectNotification':
      return translate('linear.attention.kind.project', 'Project')
    case 'DocumentNotification':
      return translate('linear.attention.kind.document', 'Document')
    case 'InitiativeNotification':
      return translate('linear.attention.kind.initiative', 'Initiative')
    case 'PullRequestNotification':
      return translate('linear.attention.kind.review', 'Code review')
    case 'CustomerNotification':
    case 'CustomerNeedNotification':
      return translate('linear.attention.kind.customer', 'Customer')
    default:
      return translate('linear.attention.kind.notification', 'Notification')
  }
}
