const rejected = new Set([
  'pipeline_source_changed',
  'pipeline_not_running',
  'pipeline_invocation_still_running',
  'pipeline_reconciliation_required',
  'pipeline_completion_conflict',
  'pipeline_candidate_conflict',
  'pipeline_owner_decision_required',
  'pipeline_revision_conflict',
  'pipeline_workspace_instance_changed',
  'pipeline_runtime_identity_changed',
  'pipeline_budget_conflict',
  'pipeline_budget_exhausted',
  'pipeline_context_budget',
  'pipeline_definition_disabled',
  'pipeline_rework_comment_required',
  'pipeline_review_requires_clean_commit',
  'pipeline_discussion_requires_agent_stage'
])
export function pipelineRunActionRejected(message: string) {
  const code = message.match(
    /^(?:Error invoking remote method '[^']+': (?:Error: )?)?(pipeline_[a-z_]+)$/
  )?.[1]
  return Boolean(code && rejected.has(code))
}
