import { prefixJiraReviewTitle } from '../../../../shared/jira/jira-review-title'
import type {
  PullRequestGenerationFields,
  PullRequestGenerationRecord
} from './pull-request-generation'

// Why: an auto-submitted run (Create PR) is sent without the user reviewing it in the form.
export type PullRequestGenerationOptions = { autoSubmit?: boolean }

type ResolvableRecord = Pick<
  PullRequestGenerationRecord,
  'autoSubmit' | 'seed' | 'seedFieldRevisions' | 'editedFields'
> &
  Pick<Partial<PullRequestGenerationRecord>, 'context'>

/** Agent may mark unfinished work Draft, but must never undo the user’s Draft choice and silently open a ready review. */
export function resolveGeneratedDraft(
  { seed, seedFieldRevisions }: Omit<ResolvableRecord, 'autoSubmit'>,
  result: PullRequestGenerationFields
): boolean {
  return seed.draft || (seedFieldRevisions.draft === 0 && result.draft)
}

/** All runs preserve Draft; only unreviewed auto-submit also preserves user base. Generated-form bases remain editable before creation. */
export function resolveGeneratedFields(
  record: ResolvableRecord,
  result: PullRequestGenerationFields
): PullRequestGenerationFields {
  const draft = resolveGeneratedDraft(record, result)
  const jiraIssueKey = record.context?.jiraIssueKey
  const title =
    jiraIssueKey && record.seedFieldRevisions.title > 0
      ? record.seed.title
      : prefixJiraReviewTitle(result.title, jiraIssueKey)
  const resolved = record.autoSubmit
    ? { ...result, base: record.seed.base, title, draft }
    : { ...result, title, draft }
  const edited = record.editedFields
  if (record.autoSubmit && edited) {
    for (const field of ['base', 'title', 'body', 'draft'] as const) {
      if (edited.revisions[field] <= record.seedFieldRevisions[field]) {
        continue
      }
      if (field === 'draft') {
        resolved.draft = edited.fields.draft
      } else {
        resolved[field] = edited.fields[field]
      }
    }
  }
  return resolved
}
