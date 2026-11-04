import { describe, expect, it } from 'vitest'
import {
  getInitialGitHubPrStartPointSelection,
  getMatchingLinkedTaskSourceContext,
  resolveSmartGitHubCreateNames,
  resolveInitialWorkspaceRunSeed
} from './composer-state/composer-decisions'

describe('useComposerState host-context boundaries', () => {
  it('seeds TaskPage pull requests as submit-time PR start points', () => {
    const item = {
      id: 'pr-42',
      type: 'pr' as const,
      number: 42,
      title: 'Fix PR workspace creation',
      state: 'open' as const,
      url: 'https://github.com/stablyai/orca/pull/42',
      labels: [],
      updatedAt: '2026-08-04T00:00:00.000Z',
      author: 'octocat',
      branchName: 'fix-pr-workspace',
      baseRefName: 'main',
      isCrossRepository: true,
      repoId: 'repo-1'
    }

    expect(
      getInitialGitHubPrStartPointSelection({
        item,
        linkedWorkItem: {
          provider: 'github',
          type: 'pr',
          number: 42,
          title: item.title,
          url: item.url,
          repoId: item.repoId
        },
        repoId: 'repo-1'
      })
    ).toEqual({ kind: 'github-pr', repoId: 'repo-1', item })
    expect(
      getInitialGitHubPrStartPointSelection({
        item,
        linkedWorkItem: {
          provider: 'github',
          type: 'pr',
          number: 43,
          title: item.title,
          url: 'https://github.com/stablyai/orca/pull/43'
        },
        repoId: 'repo-1'
      })
    ).toBeNull()
  })

  it('preserves explicit names when a linked PR start point resolves at submit time', () => {
    expect(
      resolveSmartGitHubCreateNames({
        resolutionKind: 'pr-start-point',
        smartWorkspaceName: 'title-derived-name',
        smartDisplayName: 'Title derived name',
        fallbackWorkspaceName: 'edited workspace',
        nameIsAutoManaged: false
      })
    ).toEqual({ workspaceName: 'edited workspace', displayName: undefined })
  })

  it('uses an explicit creation target without borrowing the linked Jira account host', () => {
    expect(
      resolveInitialWorkspaceRunSeed({
        initialTaskSourceContext: {
          projectId: 'account-backed-task-source',
          hostId: 'local',
          projectHostSetupId: 'unrelated-setup'
        },
        initialWorkspaceTarget: { projectId: 'mapped-project', hostId: 'ssh:builder' }
      })
    ).toEqual({ projectId: 'mapped-project', hostId: 'ssh:builder', projectHostSetupId: null })
  })

  it('keeps a restored draft target ahead of an explicit creation target', () => {
    expect(
      resolveInitialWorkspaceRunSeed({
        draftProjectId: 'draft-project',
        draftHostId: 'local',
        draftProjectHostSetupId: 'draft-setup',
        initialWorkspaceTarget: { projectId: 'mapped-project', hostId: 'ssh:builder' }
      })
    ).toEqual({ projectId: 'draft-project', hostId: 'local', projectHostSetupId: 'draft-setup' })
  })

  it('restores Jira draft context only when its site and issue identity agree', () => {
    const item = {
      provider: 'jira' as const,
      type: 'issue' as const,
      number: 0,
      title: 'ORCA-123 Link Jira',
      url: 'https://company.atlassian.net/jira/browse/ORCA-123',
      jiraIdentifier: 'ORCA-123'
    }
    const context = {
      kind: 'task-source' as const,
      provider: 'jira' as const,
      projectId: 'project-1',
      hostId: 'local' as const,
      providerIdentity: {
        provider: 'jira' as const,
        siteId: 'site-1',
        siteUrl: 'https://company.atlassian.net/jira',
        projectKey: 'ORCA'
      }
    }

    expect(getMatchingLinkedTaskSourceContext(item, context)).toEqual(context)
    expect(
      getMatchingLinkedTaskSourceContext(item, {
        ...context,
        providerIdentity: { ...context.providerIdentity, siteUrl: 'https://other.atlassian.net' }
      })
    ).toBeNull()
    expect(
      getMatchingLinkedTaskSourceContext({ ...item, jiraIdentifier: 'ORCA-999' }, context)
    ).toBeNull()
  })
})
