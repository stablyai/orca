import { isUtf8ByteLengthWithinLimit } from '../../text/utf8-byte-limits'
import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import {
  MAX_JIRA_SAVED_FILTER_ID_LENGTH,
  MAX_JIRA_SAVED_FILTER_NAME_LENGTH,
  MAX_JIRA_SAVED_FILTER_JQL_LENGTH
} from '../../jira/jira-saved-filters'

const FilterId = lazyZodSchema(() => z.string().trim().min(1).max(MAX_JIRA_SAVED_FILTER_ID_LENGTH))
export const JiraSavedFilterMutationParam = lazyZodSchema(() =>
  z.discriminatedUnion('kind', [
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
)
