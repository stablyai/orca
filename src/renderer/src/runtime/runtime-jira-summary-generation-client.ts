import { translate } from '@/i18n/i18n'
import type {
  JiraIssueSummaryGenerationRequest,
  JiraIssueSummaryGenerationCancellation,
  JiraIssueSummaryGenerationResult
} from '../../../shared/jira/jira-issue-summary-generation'
import { JIRA_ISSUE_SUMMARY_RUNTIME_CAPABILITY } from '../../../shared/jira/jira-detail-capabilities'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'

export async function generateRuntimeJiraIssueSummary(
  target: RuntimeClientTarget,
  args: JiraIssueSummaryGenerationRequest,
  signal: AbortSignal
): Promise<JiraIssueSummaryGenerationResult> {
  if (target.kind === 'environment') {
    const supported = await runtimeEnvironmentSupportsCapability(
      target.environmentId,
      JIRA_ISSUE_SUMMARY_RUNTIME_CAPABILITY
    )
    if (signal.aborted) {
      return {
        success: false,
        error: translate('components.jiraIssueTitleField.canceled', 'Generation canceled.'),
        canceled: true
      }
    }
    if (!supported) {
      return {
        success: false,
        error: translate(
          'components.jiraIssueTitleField.hostUpdateRequired',
          'Generating Jira titles requires a newer Orca server. Update the Jira connection’s host and try again.'
        )
      }
    }
    return callRuntimeRpc(target, 'jira.generateIssueSummary', args, { timeoutMs: 75_000, signal })
  }
  if (signal.aborted) {
    return {
      success: false,
      error: translate('components.jiraIssueTitleField.canceled', 'Generation canceled.'),
      canceled: true
    }
  }
  return window.api.jira.generateIssueSummary(args)
}

export async function cancelRuntimeJiraIssueSummary(
  target: RuntimeClientTarget,
  args: JiraIssueSummaryGenerationCancellation
): Promise<void> {
  await (target.kind === 'environment'
    ? callRuntimeRpc(target, 'jira.cancelGenerateIssueSummary', args, { timeoutMs: 5_000 })
    : window.api.jira.cancelGenerateIssueSummary(args))
}
