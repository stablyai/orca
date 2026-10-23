import { isUtf8ByteLengthWithinLimit } from '../utf8-byte-limits'
import { z } from 'zod'
import {
  MAX_JIRA_SAVED_FILTER_ID_LENGTH,
  MAX_JIRA_SAVED_FILTER_NAME_LENGTH,
  MAX_JIRA_SAVED_FILTER_JQL_LENGTH
} from '../jira-saved-filters'

const FilterId = z.string().trim().min(1).max(MAX_JIRA_SAVED_FILTER_ID_LENGTH)
export const JiraSavedFilterMutationParam = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('save'),
    filter: z.strictObject({
      id: FilterId,
      name: z.string().trim().min(1).max(MAX_JIRA_SAVED_FILTER_NAME_LENGTH),
      jql: z
        .string()
        .trim()
        .min(1)
        .max(MAX_JIRA_SAVED_FILTER_JQL_LENGTH)
        .refine((jql) => isUtf8ByteLengthWithinLimit(jql, MAX_JIRA_SAVED_FILTER_JQL_LENGTH))
    })
  }),
  z.strictObject({ kind: z.literal('delete'), id: FilterId }),
  z.strictObject({ kind: z.literal('select'), id: FilterId.nullable() })
])
