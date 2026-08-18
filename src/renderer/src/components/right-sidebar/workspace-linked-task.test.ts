import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  formatWorkspaceLinkedTaskReference,
  hasWorkspaceLinkedTask,
  resolveWorkspaceLinkedTask
} from './workspace-linked-task'

type LinkFields = Parameters<typeof resolveWorkspaceLinkedTask>[0]

function links(overrides: Partial<Worktree>): LinkFields {
  return {
    repoId: 'repo-1',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    ...overrides
  } as LinkFields
}

describe('resolveWorkspaceLinkedTask', () => {
  it('returns null when the workspace has no link', () => {
    expect(resolveWorkspaceLinkedTask(links({}))).toBeNull()
    expect(hasWorkspaceLinkedTask(links({}))).toBe(false)
    expect(resolveWorkspaceLinkedTask(null)).toBeNull()
  })

  it('resolves the stored work item with its own provider, not the repo provider', () => {
    const task = resolveWorkspaceLinkedTask(
      links({
        // A GitHub repo whose workspace is linked to a Jira issue: the panel must
        // render Jira, so the provider comes from the link and never from the repo.
        linkedIssue: 41,
        linkedWorkItem: {
          provider: 'jira',
          type: 'issue',
          number: 7,
          title: 'Ship the task panel',
          url: 'https://example.atlassian.net/browse/PROJ-7',
          jiraIdentifier: 'PROJ-7'
        },
        linkedTaskSourceContext: null
      })
    )
    expect(task).toMatchObject({
      provider: 'jira',
      reference: 'PROJ-7',
      title: 'Ship the task panel',
      url: 'https://example.atlassian.net/browse/PROJ-7'
    })
  })

  it('carries the link source context so the item is read on the right account', () => {
    const sourceContext: NonNullable<Worktree['linkedTaskSourceContext']> = {
      kind: 'task-source',
      provider: 'linear',
      projectId: 'project-1',
      hostId: 'local'
    }
    const task = resolveWorkspaceLinkedTask(
      links({
        linkedWorkItem: {
          provider: 'linear',
          type: 'issue',
          number: 31,
          title: 'Linked issue',
          url: 'https://linear.app/acme/issue/ENG-31',
          linearIdentifier: 'ENG-31'
        },
        linkedTaskSourceContext: sourceContext
      })
    )
    expect(task?.sourceContext).toBe(sourceContext)
  })

  it('falls back to the flat link fields for workspaces linked by number', () => {
    expect(resolveWorkspaceLinkedTask(links({ linkedIssue: 15318 }))).toMatchObject({
      provider: 'github',
      type: 'issue',
      number: 15318,
      reference: '#15318',
      title: '',
      url: '',
      repoId: 'repo-1'
    })
    expect(resolveWorkspaceLinkedTask(links({ linkedPR: 12 }))).toMatchObject({
      provider: 'github',
      type: 'pr',
      number: 12
    })
    expect(resolveWorkspaceLinkedTask(links({ linkedGitLabMR: 12 }))).toMatchObject({
      provider: 'gitlab',
      type: 'mr',
      reference: '!12'
    })
    expect(resolveWorkspaceLinkedTask(links({ linkedGitLabIssue: 12 }))).toMatchObject({
      provider: 'gitlab',
      type: 'issue',
      reference: '#12'
    })
    expect(resolveWorkspaceLinkedTask(links({ linkedLinearIssue: 'ENG-31' }))).toMatchObject({
      provider: 'linear',
      reference: 'ENG-31',
      linearIdentifier: 'ENG-31'
    })
  })

  it('prefers the stored work item over a stale flat field', () => {
    const task = resolveWorkspaceLinkedTask(
      links({
        linkedIssue: 41,
        linkedWorkItem: {
          provider: 'github',
          type: 'issue',
          number: 42,
          title: 'Current link',
          url: 'https://github.com/acme/app/issues/42'
        }
      })
    )
    expect(task?.number).toBe(42)
  })
})

describe('formatWorkspaceLinkedTaskReference', () => {
  it('keeps the GitLab merge request sigil distinct from the issue sigil', () => {
    expect(formatWorkspaceLinkedTaskReference({ provider: 'gitlab', type: 'mr', number: 9 })).toBe(
      '!9'
    )
    expect(
      formatWorkspaceLinkedTaskReference({ provider: 'gitlab', type: 'issue', number: 9 })
    ).toBe('#9')
  })

  it('falls back to the number when a provider identifier was never stored', () => {
    expect(
      formatWorkspaceLinkedTaskReference({ provider: 'linear', type: 'issue', number: 4 })
    ).toBe('#4')
  })
})

describe('resolveWorkspaceLinkedTask repo context', () => {
  it("falls back to the workspace's repo when the stored link records none", () => {
    // Why: links created from a task source carry title and URL but no repoId,
    // and without a repo there is no path to read the item's details against.
    const task = resolveWorkspaceLinkedTask(
      links({
        repoId: 'repo-1',
        linkedWorkItem: {
          provider: 'github',
          type: 'pr',
          number: 493,
          title: 'Release R14 scheduling start',
          url: 'https://github.com/acme/app/pull/493'
        },
        linkedTaskSourceContext: {
          kind: 'task-source',
          provider: 'github',
          projectId: 'github:acme/app',
          hostId: 'local',
          repoId: 'repo-from-source'
        }
      })
    )
    expect(task?.repoId).toBe('repo-1')
  })

  it('prefers the repo the link itself recorded', () => {
    const task = resolveWorkspaceLinkedTask(
      links({
        repoId: 'repo-1',
        linkedWorkItem: {
          provider: 'github',
          type: 'issue',
          number: 7,
          title: 'Linked issue',
          url: 'https://github.com/acme/other/issues/7',
          repoId: 'repo-on-link'
        }
      })
    )
    expect(task?.repoId).toBe('repo-on-link')
  })

  it('falls back to the source context repo when the workspace has none', () => {
    const task = resolveWorkspaceLinkedTask({
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      linkedWorkItem: {
        provider: 'github',
        type: 'issue',
        number: 9,
        title: 'Linked issue',
        url: 'https://github.com/acme/app/issues/9'
      },
      linkedTaskSourceContext: {
        kind: 'task-source',
        provider: 'github',
        projectId: 'github:acme/app',
        hostId: 'local',
        repoId: 'repo-from-source'
      }
    } as Parameters<typeof resolveWorkspaceLinkedTask>[0])
    expect(task?.repoId).toBe('repo-from-source')
  })
})
