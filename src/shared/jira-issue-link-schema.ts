import { z } from 'zod'
import type { JiraIssueLink } from './types'
import { normalizeJiraIssueLink } from './jira-issue-link'

export const JiraIssueLinkSchema = z.unknown().transform((value, ctx): JiraIssueLink => {
  const normalized = normalizeJiraIssueLink(value)
  if (!normalized) {
    ctx.addIssue({ code: 'custom', message: 'Invalid Jira issue link' })
    return z.NEVER
  }
  return normalized
})
