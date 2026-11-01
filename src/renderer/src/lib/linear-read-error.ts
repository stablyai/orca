import type {
  LinearIssueData,
  LinearIssueView
} from '@/store/slices/linear/linear-issue-publication'
import { translate } from '@/i18n/i18n'
import {
  credentialDecryptionMessage,
  isIntegrationCredentialDecryptionError
} from '../../../shared/integration-credential-errors'
import { isLinearIssueAttributeFilterUnsupportedError } from '@/runtime/runtime-linear-client'

export function linearIssueReadError(error: unknown): string {
  if (isIntegrationCredentialDecryptionError(error)) {
    return credentialDecryptionMessage('Linear')
  }
  if (isLinearIssueAttributeFilterUnsupportedError(error)) {
    return error.message
  }
  return `${translate('auto.components.TaskPage.cc8795e07c', 'Unable to load Linear issues')}. ${translate('auto.store.slices.runtime.status.tryAgain', 'Try again')}.`
}

export function linearIssueViewError(view: LinearIssueView<LinearIssueData>): string | null {
  if (view.kind === 'error') {
    return linearIssueReadError(view.error)
  }
  const data = view.data
  const error = data && !Array.isArray(data) && 'errors' in data ? data.errors?.[0]?.message : null
  return error ? linearIssueReadError(error) : null
}
