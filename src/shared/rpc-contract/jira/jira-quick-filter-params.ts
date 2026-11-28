import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { MAX_JIRA_STATUS_FILTERS, MAX_JIRA_STATUS_NAME_LENGTH } from '../../jira/jira-quick-filters'

const JiraStatuses = lazyZodSchema(() =>
  z
    .array(
      z
        .string()
        .min(1)
        .max(MAX_JIRA_STATUS_NAME_LENGTH)
        .refine((name) => name.trim().length > 0)
    )
    .max(MAX_JIRA_STATUS_FILTERS)
)

export const JiraQuickFilterStateParam = lazyZodSchema(() =>
  z.strictObject({ statuses: JiraStatuses })
)
export const JiraIssueListFiltersParam = lazyZodSchema(() =>
  z.strictObject({
    currentSprint: z.boolean().optional(),
    statuses: JiraStatuses.optional()
  })
)
