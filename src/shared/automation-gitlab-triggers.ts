// GitLab events as a bot automation's webhook rule. GitLab signs its webhooks with Standard Webhooks
// (19.0+), so a GitLab rule is an ordinary `webhook.call` rule whose first clause names the GitLab
// event header; the host registers the project webhook itself (src/main/gitlab/events).
import type { WebhookFilters, WebhookWhere } from './connector-webhook-contract'

export const GITLAB_EVENT_KINDS = [
  'comment',
  'issue_opened',
  'mr_opened',
  'mr_merged',
  'pipeline_failed'
] as const
export type GitLabEventKind = (typeof GITLAB_EVENT_KINDS)[number]

/** The GitLab project webhook flag each event needs. */
export type GitLabHookFlag =
  | 'note_events'
  | 'issues_events'
  | 'merge_requests_events'
  | 'pipeline_events'

/** What a GitLab rule listens for; `projects` are "group/project" paths on `host` (glab's default when absent). */
export type GitLabEventRule = {
  event: GitLabEventKind
  projects: string[]
  host?: string
  /** GitLab usernames, without the @. */
  from?: string[]
  /** gitlab.comment only: the comment's text contains this, in any case. */
  contains?: string
}

type GitLabEventSpec = {
  header: string
  flag: GitLabHookFlag
  where: WebhookWhere[]
  subjectFrom: string
  pick: string[]
}

const PROJECT_PATH = 'body.project.path_with_namespace'
const USER_PATH = 'body.user.username'
const NOTE_PATH = 'body.object_attributes.note'
export const GITLAB_EVENT_HEADER_PATH = 'headers.x-gitlab-event'
const INSTANCE_HEADER_PATH = 'headers.x-gitlab-instance'

const ITEM_PICK = [
  'body.object_attributes.title',
  'body.object_attributes.description',
  'body.object_attributes.url',
  'body.object_attributes.iid',
  USER_PATH,
  PROJECT_PATH
]

const SPECS: Record<GitLabEventKind, GitLabEventSpec> = {
  comment: {
    header: 'Note Hook',
    flag: 'note_events',
    // GitLab also sends commit and snippet comments as Note Hook.
    where: [
      { path: 'body.object_attributes.noteable_type', op: 'in', values: ['Issue', 'MergeRequest'] }
    ],
    // The discussion, unique on the instance, so replies in one thread fold into one run.
    subjectFrom: 'body.object_attributes.discussion_id',
    pick: [
      NOTE_PATH,
      'body.object_attributes.url',
      'body.object_attributes.noteable_type',
      'body.issue.iid',
      'body.merge_request.iid',
      USER_PATH,
      PROJECT_PATH
    ]
  },
  issue_opened: {
    header: 'Issue Hook',
    flag: 'issues_events',
    where: [{ path: 'body.object_attributes.action', op: '=', values: ['open'] }],
    subjectFrom: 'body.object_attributes.id',
    pick: ITEM_PICK
  },
  mr_opened: {
    header: 'Merge Request Hook',
    flag: 'merge_requests_events',
    where: [{ path: 'body.object_attributes.action', op: '=', values: ['open'] }],
    subjectFrom: 'body.object_attributes.id',
    pick: [
      ...ITEM_PICK,
      'body.object_attributes.source_branch',
      'body.object_attributes.target_branch'
    ]
  },
  mr_merged: {
    header: 'Merge Request Hook',
    flag: 'merge_requests_events',
    where: [{ path: 'body.object_attributes.action', op: '=', values: ['merge'] }],
    subjectFrom: 'body.object_attributes.id',
    pick: [...ITEM_PICK, 'body.object_attributes.target_branch']
  },
  pipeline_failed: {
    header: 'Pipeline Hook',
    flag: 'pipeline_events',
    where: [{ path: 'body.object_attributes.status', op: '=', values: ['failed'] }],
    subjectFrom: 'body.object_attributes.id',
    pick: [
      'body.object_attributes.status',
      'body.object_attributes.ref',
      'body.object_attributes.url',
      'body.merge_request.iid',
      'body.merge_request.url',
      'body.commit.url',
      USER_PATH,
      PROJECT_PATH
    ]
  }
}

export function gitlabHookFlag(event: GitLabEventKind): GitLabHookFlag {
  return SPECS[event].flag
}

/** The webhook filters that listen for `rule`. */
export function gitlabWebhookFilters(rule: GitLabEventRule): WebhookFilters {
  const spec = SPECS[rule.event]
  return {
    where: [
      { path: GITLAB_EVENT_HEADER_PATH, op: '=', values: [spec.header] },
      { path: PROJECT_PATH, op: 'in', values: rule.projects },
      ...(rule.host
        ? [{ path: INSTANCE_HEADER_PATH, op: '=' as const, values: [`https://${rule.host}`] }]
        : []),
      ...spec.where,
      ...(rule.from?.length ? [{ path: USER_PATH, op: 'in' as const, values: rule.from }] : []),
      ...(rule.contains
        ? [{ path: NOTE_PATH, op: 'contains' as const, values: [rule.contains] }]
        : [])
    ],
    pick: spec.pick,
    subjectFrom: spec.subjectFrom
  }
}

function valuesAt(where: readonly WebhookWhere[], path: string): string[] | undefined {
  return where.find((clause) => clause.path === path)?.values
}

const filtersKey = (filters: WebhookFilters) =>
  JSON.stringify([
    (filters.where ?? []).map(({ path, op, values }) => [path, op, values ?? []]),
    filters.textContains ?? '',
    filters.pick ?? [],
    filters.subjectFrom ?? '',
    filters.subject ?? ''
  ])

/** The GitLab rule these filters were made from, or null for any other webhook rule. */
export function gitlabEventRuleOf(filters: WebhookFilters): GitLabEventRule | null {
  const where = filters.where ?? []
  const header = valuesAt(where, GITLAB_EVENT_HEADER_PATH)?.[0]
  const projects = valuesAt(where, PROJECT_PATH)
  if (!header || !projects?.length) {
    return null
  }
  const instance = valuesAt(where, INSTANCE_HEADER_PATH)?.[0]
  const from = valuesAt(where, USER_PATH)
  const contains = valuesAt(where, NOTE_PATH)?.[0]
  const rest = {
    projects,
    ...(instance?.startsWith('https://') ? { host: instance.slice('https://'.length) } : {}),
    ...(from?.length ? { from } : {}),
    ...(contains ? { contains } : {})
  }
  // Read back only when the filters are exactly what that rule makes, so an edited rule is a plain webhook.
  const same = filtersKey(filters)
  return (
    GITLAB_EVENT_KINDS.map((event): GitLabEventRule => ({ event, ...rest })).find(
      (rule) => filtersKey(gitlabWebhookFilters(rule)) === same
    ) ?? null
  )
}
