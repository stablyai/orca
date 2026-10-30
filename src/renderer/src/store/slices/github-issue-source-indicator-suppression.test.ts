import { describe, expect, it } from 'vitest'
import './github-slice-test-harness'

describe('IssueSourceIndicator suppression', () => {
  it('hides when sources deep-equal, shows when they differ, hides when either is null', async () => {
    const { default: IssueSourceIndicator, sameGitHubOwnerRepo } =
      await import('../../components/github/IssueSourceIndicator')
    const React = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')

    expect(sameGitHubOwnerRepo({ owner: 'o', repo: 'r' }, { owner: 'o', repo: 'r' })).toBe(true)
    // Repo slug comparison is case-insensitive; equivalent owners convey no source change.
    expect(
      sameGitHubOwnerRepo({ owner: 'StablyAI', repo: 'Orca' }, { owner: 'stablyai', repo: 'orca' })
    ).toBe(true)
    expect(
      sameGitHubOwnerRepo(
        { owner: 'stablyai', repo: 'orca', host: 'github.com' },
        { owner: 'stablyai', repo: 'orca', host: 'ghe.example.test' }
      )
    ).toBe(false)
    expect(sameGitHubOwnerRepo({ owner: 'a', repo: 'r' }, { owner: 'b', repo: 'r' })).toBe(false)

    const sameEl = React.createElement(IssueSourceIndicator, {
      issues: { owner: 'o', repo: 'r' },
      prs: { owner: 'o', repo: 'r' }
    })
    expect(renderToStaticMarkup(sameEl)).toBe('')

    const nullIssueEl = React.createElement(IssueSourceIndicator, {
      issues: null,
      prs: { owner: 'o', repo: 'r' }
    })
    expect(renderToStaticMarkup(nullIssueEl)).toBe('')

    const diffEl = React.createElement(IssueSourceIndicator, {
      issues: { owner: 'up', repo: 'r' },
      prs: { owner: 'fork', repo: 'r' }
    })
    const defaultMarkup = renderToStaticMarkup(diffEl)
    expect(defaultMarkup).toContain('up/r')
    expect(defaultMarkup).toContain('Issues from')

    // Item surfaces annotate one issue, so use singular prefix.
    const itemEl = React.createElement(IssueSourceIndicator, {
      issues: { owner: 'up', repo: 'r' },
      prs: { owner: 'fork', repo: 'r' },
      variant: 'item'
    })
    const itemMarkup = renderToStaticMarkup(itemEl)
    expect(itemMarkup).toContain('up/r')
    expect(itemMarkup).toContain('Issue from')
    expect(itemMarkup).not.toContain('Issues from')

    const enterpriseEl = React.createElement(IssueSourceIndicator, {
      issues: { owner: 'up', repo: 'r', host: 'ghe.example.test' },
      prs: { owner: 'fork', repo: 'r', host: 'ghe.example.test' }
    })
    expect(renderToStaticMarkup(enterpriseEl)).toContain('ghe.example.test/up/r')
  })
})
