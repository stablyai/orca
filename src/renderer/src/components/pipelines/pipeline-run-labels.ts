import type { Translate } from '@/i18n/use-translate'

export function pipelineRunReasonLabel(reason: string | undefined, t: Translate) {
  switch (reason) {
    case undefined:
      return undefined
    case 'pipeline_response_quota':
      return t(
        'pipelines.stopQuota',
        'The provider usage limit stopped this turn. Inspect the existing session before retrying.'
      )
    case 'pipeline_response_cancellation':
      return t(
        'pipelines.stopCancellation',
        'The agent turn was cancelled. No stage result was accepted.'
      )
    case 'pipeline_response_malformed_result':
      return t(
        'pipelines.stopMalformed',
        'The response did not satisfy the stage contract. Its original text and validation errors are retained below.'
      )
    case 'pipeline_response_transport_unknown':
    case 'pipeline_response_outcome_unknown':
      return t(
        'pipelines.stopUnknown',
        'The turn outcome is unconfirmed. Inspect the existing invocation; it will not be relaunched automatically.'
      )
    case 'pipeline_source_changed':
    case 'pipeline_response_source_mismatch':
      return t(
        'pipelines.stopSourceChanged',
        'The source no longer matches the pinned evidence. Readiness is not confirmed.'
      )
    case 'pipeline_source_unavailable':
      return t(
        'pipelines.stopSourceUnavailable',
        'The current source could not be verified. Reconcile the existing response after source access is restored.'
      )
    case 'pipeline_review_source_flags_unverifiable':
      return t(
        'pipelines.stopSourceFlags',
        'Git index flags hide source changes. A clean review commit cannot be verified; Orca has not changed those flags.'
      )
    case 'pipeline_findings_unresolved':
      return t(
        'pipelines.stopFindings',
        'Important retained findings remain unresolved under the selected completion policy.'
      )
    default:
      return reason
  }
}

export function pipelineRunStateLabel(state: string, t: Translate) {
  switch (state) {
    case 'waiting_setup':
      return t('pipelines.waitingSetup', 'Waiting for setup')
    case 'running':
      return t('pipelines.running', 'Running')
    case 'paused':
      return t('pipelines.paused', 'Paused')
    case 'waiting_owner':
      return t('pipelines.waitsForYou', 'Waits for you')
    case 'reconciliation_required':
      return t('pipelines.resultUnknown', 'Result needs checking')
    case 'completed':
      return t('pipelines.completed', 'Completed')
    case 'failed':
      return t('pipelines.failed', 'Failed')
    case 'pending':
      return t('pipelines.pending', 'Pending')
    case 'blocked':
      return t('pipelines.blocked', 'Blocked')
    case 'interrupted':
      return t('pipelines.interrupted', 'Interrupted')
    default:
      return t('pipelines.unknownState', 'State unavailable')
  }
}
