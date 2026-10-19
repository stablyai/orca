import type React from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { getJiraSourceStatusMessage } from '../new-workspace/jira-source-status-message'
import type { WorkItemSourceSearch } from '../new-workspace/use-work-item-source-search'

export function WorkspaceAttachmentSourceStatus({
  controller,
  taskUrlProvider,
  resolved,
  error,
  onRetry
}: {
  controller: WorkItemSourceSearch
  taskUrlProvider: 'linear' | 'jira' | null
  resolved: boolean
  error: string | null
  onRetry: () => void
}): React.JSX.Element {
  let message =
    error ?? translate('workspace.links.inlineSearchHint', 'Select a result to attach it.')
  let retry: (() => void) | null = null
  if (!error && taskUrlProvider === 'jira') {
    if (controller.jiraSource.intent) {
      message = getJiraSourceStatusMessage(controller.jiraSource)
      if (controller.jiraSource.errorKind) {
        retry = controller.jiraSource.retry
      }
    } else {
      message = translate(
        'workspace.links.jiraModeRequired',
        'Select Smart or Jira to load this issue.'
      )
      retry = () => controller.setMode('jira')
    }
  } else if (!error && taskUrlProvider === 'linear' && !resolved) {
    if (!controller.linearUrlIntentOwnsInput) {
      message = translate(
        'workspace.links.linearModeRequired',
        'Select Smart or Linear to load this issue.'
      )
      retry = () => controller.setMode('linear')
    } else if (!controller.linearStatusChecked) {
      message = translate('workspace.links.loadingLinear', 'Loading Linear issue…')
    } else if (!controller.linearStatus.connected) {
      message = translate(
        'workspace.links.linearConnectRequired',
        'Connect Linear in Settings to link this issue.'
      )
      retry = onRetry
    } else if (controller.unresolvedLinearUrlIntent || controller.linearLoading) {
      message = translate('workspace.links.loadingLinear', 'Loading Linear issue…')
    } else {
      message = translate(
        'workspace.links.linearReadFailed',
        'Couldn’t load this Linear issue. Check the URL and connected workspace.'
      )
      retry = onRetry
    }
  }
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground"
    >
      <span>{message}</span>
      {retry ? (
        <Button
          type="button"
          variant="link"
          size="xs"
          disabled={controller.disabled}
          onClick={retry}
        >
          {translate('workspace.links.retrySource', 'Retry')}
        </Button>
      ) : null}
    </div>
  )
}
