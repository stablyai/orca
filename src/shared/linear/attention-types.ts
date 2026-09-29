import type { LinearIssue } from './issue-types'
import type { LinearPersonalReadScope } from './personal-read-types'

export type LinearAttentionRequest = {
  workspaceId: string
  cursor?: string
}
export type LinearInboxItem = {
  id: string
  kind: string
  type: string
  title: string
  subtitle: string
  url: string
  readAt: string | null
  snoozedUntilAt: string | null
  updatedAt: string
  issue: { id: string; identifier: string; title: string; url: string } | null
}
export type LinearInboxPage = {
  scope: LinearPersonalReadScope
  items: LinearInboxItem[]
  nextCursor: string | null
}
export type LinearTriagePage = {
  items: LinearIssue[]
  nextCursor: string | null
  unavailable?: string
}
