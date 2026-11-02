import { expect, it } from 'vitest'
import type { WorkspaceAttachment } from '../../../../shared/worktree/types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import { getWorkspaceAttachmentSourceLabel } from './workspace-attachment-source-label'

function source(
  provider: TaskSourceContext['provider'],
  providerIdentity: TaskSourceContext['providerIdentity'],
  accountLabel?: string
): TaskSourceContext {
  return {
    kind: 'task-source',
    provider,
    projectId: 'project',
    hostId: 'runtime:host',
    providerIdentity,
    accountLabel
  }
}

const linearSource = source(
  'linear',
  {
    provider: 'linear',
    workspaceId: 'internal-workspace-id',
    workspaceName: 'Engineering'
  },
  'alice@example.com'
)
const linear: WorkspaceAttachment = {
  provider: 'linear',
  type: 'issue',
  number: 0,
  identifier: 'ENG-215',
  url: 'https://linear.app/acme/issue/ENG-215/title',
  taskSourceContext: linearSource
}
const jira: WorkspaceAttachment = {
  provider: 'jira',
  type: 'issue',
  number: 0,
  identifier: 'APP-18',
  url: 'https://jira.example.com/team/browse/APP-18',
  taskSourceContext: source(
    'jira',
    {
      provider: 'jira',
      siteId: 'internal-site-id',
      siteUrl: 'https://jira.example.com/team/'
    },
    'alice@example.com'
  )
}
const cases: { name: string; item: Partial<WorkspaceAttachment>; expected: string | null }[] = [
  {
    name: 'Linear workspace, organization and account',
    item: linear,
    expected: 'Engineering · acme · alice@example.com'
  },
  {
    name: 'another Linear organization',
    item: { ...linear, url: 'https://linear.app/other/issue/ENG-215/title' },
    expected: 'Engineering · other · alice@example.com'
  },
  {
    name: 'another Linear account',
    item: { ...linear, taskSourceContext: { ...linearSource, accountLabel: 'bob@example.com' } },
    expected: 'Engineering · acme · bob@example.com'
  },
  {
    name: 'Jira site path and account',
    item: jira,
    expected: 'jira.example.com/team · alice@example.com'
  },
  {
    name: 'Jira URL without stored context',
    item: {
      ...jira,
      url: 'https://jira.example.com/other/browse/APP-18',
      taskSourceContext: undefined
    },
    expected: 'jira.example.com/other'
  },
  {
    name: 'GitHub Enterprise host',
    item: { url: 'https://github.example.com/Owner/Repo/pull/7' },
    expected: 'github.example.com/Owner/Repo'
  },
  {
    name: 'GitHub issue',
    item: { type: 'issue', url: 'https://github.com/Owner/Repo/issues/7' },
    expected: 'Owner/Repo'
  },
  {
    name: 'nested GitLab group',
    item: {
      provider: 'gitlab',
      type: 'issue',
      url: 'https://gitlab.example.com/Group/Subgroup/Repo/-/work_items/7'
    },
    expected: 'gitlab.example.com/Group/Subgroup/Repo'
  },
  {
    name: 'legacy GitHub identity without URL',
    item: {
      taskSourceContext: source('github', { provider: 'github', owner: 'acme', repo: 'orca' })
    },
    expected: 'acme/orca'
  },
  {
    name: 'legacy GitLab identity without URL',
    item: {
      provider: 'gitlab',
      type: 'mr',
      taskSourceContext: source('gitlab', {
        provider: 'gitlab',
        namespace: 'acme/team',
        project: 'orca'
      })
    },
    expected: 'acme/team/orca'
  },
  {
    name: 'GitHub URL takes precedence over stale identity',
    item: {
      url: 'https://github.com/actual/repo/pull/7',
      taskSourceContext: source('github', { provider: 'github', owner: 'old', repo: 'repo' })
    },
    expected: 'actual/repo'
  },
  {
    name: 'Bitbucket scope excludes query secrets',
    item: {
      provider: 'bitbucket',
      url: 'https://bitbucket.org/Team/Repo/pull-requests/7?token=secret'
    },
    expected: 'bitbucket.org/Team/Repo'
  },
  {
    name: 'Jira rejects embedded credentials',
    item: {
      ...jira,
      url: 'https://user:secret@jira.example.com/browse/APP-18',
      taskSourceContext: undefined
    },
    expected: null
  },
  {
    name: 'opaque identifiers are not human labels',
    item: {
      ...linear,
      url: undefined,
      linearWorkspaceId: 'opaque-workspace-id',
      taskSourceContext: source('linear', {
        provider: 'linear',
        workspaceId: 'opaque-workspace-id',
        workspaceName: '1a234567-1234-1234-1234-123456789abc'
      })
    },
    expected: null
  },
  { name: 'missing source', item: {}, expected: null }
]
it.each(cases)('$name', ({ item, expected }) => {
  expect(
    getWorkspaceAttachmentSourceLabel({ provider: 'github', type: 'pr', number: 7, ...item })
  ).toBe(expected)
})
