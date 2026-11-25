import { z } from 'zod'
import { YOUTRACK_BODY_MAX_CHARS, YOUTRACK_ISSUE_PRESETS } from '../youtrack-types'
import { requiredString } from './rpc-param-primitives'

/** Hints the CLI sends so `--current` resolves the issue linked to the caller's worktree. */
export const YouTrackCurrentContext = z.object({
  cwd: z.string().max(32_768).optional(),
  worktreeId: z.string().max(2048).optional(),
  terminalHandle: z.string().max(1024).optional(),
  remote: z.boolean().optional()
})

const issueTarget = {
  /** Issue ID ("PROJ-81") or an issue URL on the connected instance. */
  id: z.string().trim().min(1).max(4096).optional(),
  current: YouTrackCurrentContext.optional()
}

export const YouTrackIssueRead = z.object({ ...issueTarget, comments: z.boolean().optional() })

export const YouTrackIssueList = z.object({
  preset: z.enum(YOUTRACK_ISSUE_PRESETS).optional(),
  query: z.string().max(2000).optional(),
  limit: z.number().int().min(1).max(200).optional()
})

export const YouTrackCommentAdd = z.object({
  ...issueTarget,
  text: requiredString('Missing comment text').pipe(z.string().max(YOUTRACK_BODY_MAX_CHARS))
})

export const YouTrackStateSet = z.object({
  ...issueTarget,
  state: requiredString('Missing --to state').pipe(z.string().max(200))
})

export const YouTrackFieldSet = z.object({
  ...issueTarget,
  name: requiredString('Missing --name').pipe(z.string().max(200)),
  values: z.array(z.string().max(20_000)).max(200)
})

export const YouTrackIssueCreate = z.object({
  project: requiredString('Missing --project').pipe(z.string().max(200)),
  summary: requiredString('Missing --summary').pipe(z.string().max(1000)),
  description: z.string().max(YOUTRACK_BODY_MAX_CHARS).optional(),
  fields: z
    .array(z.object({ name: z.string().min(1).max(200), values: z.array(z.string().max(20_000)) }))
    .max(100)
    .optional()
})
