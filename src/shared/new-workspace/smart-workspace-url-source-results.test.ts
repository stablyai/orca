import { describe, expect, it } from 'vitest'
import { buildSmartWorkspaceUrlSourceRows } from './smart-workspace-url-source-results'

describe('smart workspace URL-owned source rows', () => {
  it('hides unrelated held results while a full GitHub URL resolves', () => {
    const targetUrl = 'https://github.com/acme/widgets/issues/42'
    const staleItem = {
      id: 'issue-17',
      type: 'issue' as const,
      number: 17,
      title: 'Wrong cached issue',
      state: 'open' as const,
      url: 'https://github.com/acme/widgets/issues/17',
      labels: [],
      updatedAt: '2026-08-01T00:00:00.000Z',
      author: 'octocat',
      repoId: 'repo-1'
    }

    expect(
      buildSmartWorkspaceUrlSourceRows({
        mode: 'smart',
        value: targetUrl,
        githubUrlIntent: {
          slug: { owner: 'acme', repo: 'widgets', host: 'github.com' },
          type: 'issue',
          number: 42
        },
        githubItems: [
          staleItem,
          {
            ...staleItem,
            id: 'same-number-other-repo',
            number: 42,
            url: 'https://github.com/acme/other-repo/issues/42'
          },
          {
            ...staleItem,
            id: 'same-number-pull-request',
            type: 'pr',
            number: 42,
            url: 'https://github.com/acme/widgets/pull/42'
          }
        ],
        gitlabItems: [],
        linearIssues: [],
        gitlabAvailable: false,
        linearAvailable: false,
        linearUrlIntentOwnsResults: true,
        resultLimit: 12
      })
    ).toEqual([{ kind: 'use-name', value: 'use-name', name: targetUrl }])
  })

  it('shows only the exact GitHub URL result after lookup settles', () => {
    const targetUrl = 'https://github.com/acme/widgets/issues/42'
    const exactItem = {
      id: 'issue-42',
      type: 'issue' as const,
      number: 42,
      title: 'Exact pasted issue',
      state: 'open' as const,
      url: targetUrl,
      labels: [],
      updatedAt: '2026-08-02T00:00:00.000Z',
      author: 'octocat',
      repoId: 'repo-1'
    }

    expect(
      buildSmartWorkspaceUrlSourceRows({
        mode: 'smart',
        value: targetUrl,
        githubUrlIntent: {
          slug: { owner: 'ACME', repo: 'Widgets', host: 'GitHub.com' },
          type: 'issue',
          number: 42
        },
        githubItems: [
          { ...exactItem, id: 'issue-17', number: 17, url: `${targetUrl.slice(0, -2)}17` },
          exactItem
        ],
        gitlabItems: [],
        linearIssues: [],
        gitlabAvailable: false,
        linearAvailable: false,
        linearUrlIntentOwnsResults: true,
        resultLimit: 12
      })
    ).toEqual([
      { kind: 'use-name', value: 'use-name', name: targetUrl },
      { kind: 'github', value: 'github-repo-1-issue-42', item: exactItem }
    ])
  })

  it('hides unrelated held results while a full GitLab URL resolves', () => {
    const targetUrl = 'https://gitlab.example.test/acme/widgets/-/issues/42'
    const staleItem = {
      id: 'mr-17',
      type: 'mr' as const,
      number: 17,
      title: 'Wrong cached merge request',
      state: 'opened' as const,
      url: 'https://gitlab.example.test/acme/widgets/-/merge_requests/17',
      labels: [],
      updatedAt: '2026-08-01T00:00:00.000Z',
      author: 'gitlab-user',
      repoId: 'repo-1'
    }

    expect(
      buildSmartWorkspaceUrlSourceRows({
        mode: 'smart',
        value: targetUrl,
        gitlabUrlIntent: {
          slug: { host: 'gitlab.example.test', path: 'acme/widgets' },
          type: 'issue',
          number: 42
        },
        githubItems: [],
        gitlabItems: [
          staleItem,
          {
            ...staleItem,
            id: 'same-number-other-project',
            type: 'issue',
            number: 42,
            url: 'https://gitlab.example.test/acme/other/-/issues/42'
          },
          {
            ...staleItem,
            id: 'same-project-other-host',
            type: 'issue',
            number: 42,
            url: 'https://gitlab.other.test/acme/widgets/-/issues/42'
          }
        ],
        linearIssues: [],
        gitlabAvailable: true,
        linearAvailable: false,
        linearUrlIntentOwnsResults: true,
        resultLimit: 12
      })
    ).toEqual([{ kind: 'use-name', value: 'use-name', name: targetUrl }])
  })

  it('shows only the exact GitLab URL result after lookup settles', () => {
    const targetUrl = 'https://gitlab.example.test/acme/widgets/-/issues/42'
    const exactItem = {
      id: 'issue-42',
      type: 'issue' as const,
      number: 42,
      title: 'Exact pasted issue',
      state: 'opened' as const,
      url: targetUrl,
      labels: [],
      updatedAt: '2026-08-02T00:00:00.000Z',
      author: 'gitlab-user',
      repoId: 'repo-1'
    }

    expect(
      buildSmartWorkspaceUrlSourceRows({
        mode: 'smart',
        value: targetUrl,
        gitlabUrlIntent: {
          slug: { host: 'GITLAB.EXAMPLE.TEST', path: 'Acme/Widgets' },
          type: 'issue',
          number: 42
        },
        githubItems: [],
        gitlabItems: [
          {
            ...exactItem,
            id: 'issue-17',
            number: 17,
            url: 'https://gitlab.example.test/acme/widgets/-/issues/17'
          },
          exactItem
        ],
        linearIssues: [],
        gitlabAvailable: true,
        linearAvailable: false,
        linearUrlIntentOwnsResults: true,
        resultLimit: 12
      })
    ).toEqual([
      { kind: 'use-name', value: 'use-name', name: targetUrl },
      { kind: 'gitlab', value: 'gitlab-repo-1-issue-42', item: exactItem }
    ])
  })

  it('hides held provider rows when a Linear URL is recognized but disconnected', () => {
    const issueUrl = 'https://linear.app/stably/issue/STA-4084/restore-shell-integration'

    expect(
      buildSmartWorkspaceUrlSourceRows({
        mode: 'smart',
        value: issueUrl,
        githubItems: [{ repoId: 'repo-1', type: 'issue', number: 17 } as never],
        gitlabItems: [{ repoId: 'repo-1', type: 'mr', number: 17 } as never],
        linearIssues: [],
        gitlabAvailable: true,
        linearAvailable: false,
        linearUrlIntentOwnsResults: true,
        resultLimit: 12
      })
    ).toEqual([{ kind: 'use-name', value: 'use-name', name: issueUrl }])
  })
})
