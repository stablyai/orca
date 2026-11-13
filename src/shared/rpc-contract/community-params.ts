import { z } from 'zod'

export const CommunityNumberParams = z.object({
  number: z.number().int().positive().max(2_147_483_647)
})
export const CommunityQueryParams = z.object({
  query: z.string().max(512).optional(),
  view: z.enum(['explore', 'saved', 'viewed', 'selected']).optional(),
  area: z.string().max(128).optional(),
  kind: z.string().max(128).optional(),
  images: z.boolean().optional(),
  sort: z.enum(['updated', 'popular', 'oldest']).optional(),
  offset: z.number().int().min(0).max(20_000).optional(),
  limit: z.number().int().min(1).max(60).optional()
})
const number = CommunityNumberParams.shape.number
const chat = z.object({
  headSha: z
    .string()
    .regex(/^[a-f0-9]{40,64}$/)
    .nullable(),
  sessionId: z.string().min(1).max(8192),
  tabId: z.string().min(1).max(8192),
  workspaceId: z.string().min(1).max(8192),
  environmentId: z.string().min(1).max(8192).nullable(),
  agent: z.enum(['codex', 'claude'])
})
export const CommunityFeatureActionParams = z.discriminatedUnion('action', [
  z.object({ number, action: z.enum(['save', 'unsave', 'select', 'unselect']) }),
  z.object({ number, action: z.literal('visit'), headSha: z.string().regex(/^[a-f0-9]{40,64}$/) }),
  z.object({ number, action: z.literal('link-chat'), chat })
])
export const CommunityHistoryParams = CommunityNumberParams.extend({
  before: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(100).optional()
})
export const CommunityAccountParams = z.object({
  user: z
    .string()
    .regex(/^[a-z\d](?:[a-z\d-]{0,38})$/i)
    .nullable()
})

export const CommunityCandidateIdParams = z.object({ id: z.uuid() })
export const CommunityCandidateDispatchParams = CommunityCandidateIdParams.extend({
  repository: z.string().regex(/^[a-z\d-]{1,39}\/orca$/i),
  ref: z.string().min(1).max(255)
})

export const CommunityEvidenceParams = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) })

export const CommunityCandidateHistoryParams = z.object({
  offset: z.number().int().min(0).max(10_000).optional()
})

export const CommunityDetailParams = CommunityNumberParams.extend({ force: z.boolean().optional() })
