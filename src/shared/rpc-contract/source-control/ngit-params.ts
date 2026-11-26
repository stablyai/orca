import { z } from 'zod'
import { NGIT_STATUS_ACTIONS } from '../../ngit/ngit-work-item-types'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { requiredString } from '../rpc-param-primitives'

const MAX_TITLE_LENGTH = 512
const MAX_BODY_LENGTH = 64 * 1024

const EventId = z.string().regex(/^[0-9a-f]{64}$/, 'Invalid Nostr event id')
const WorkItemType = z.enum(['issue', 'pr'])

export const NgitRepoSelector = lazyZodSchema(() =>
  z.object({
    repo: requiredString('Missing repo selector')
  })
)

export const NgitWorkItemsList = lazyZodSchema(() =>
  NgitRepoSelector.extend({
    force: z.boolean().optional()
  })
)

export const NgitWorkItemSelector = lazyZodSchema(() =>
  NgitRepoSelector.extend({
    eventId: EventId,
    force: z.boolean().optional()
  })
)

export const NgitIssueCreate = lazyZodSchema(() =>
  NgitRepoSelector.extend({
    title: z.string().trim().min(1, 'Missing title').max(MAX_TITLE_LENGTH),
    body: z.string().max(MAX_BODY_LENGTH)
  })
)

export const NgitCommentAdd = lazyZodSchema(() =>
  NgitRepoSelector.extend({
    type: WorkItemType,
    eventId: EventId,
    body: z.string().trim().min(1, 'Missing comment').max(MAX_BODY_LENGTH)
  })
)

export const NgitStatusChange = lazyZodSchema(() =>
  NgitRepoSelector.extend({
    type: WorkItemType,
    eventId: EventId,
    action: z.enum([...new Set([...NGIT_STATUS_ACTIONS.issue, ...NGIT_STATUS_ACTIONS.pr])])
  })
)
