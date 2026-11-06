// @vitest-environment happy-dom

import { act, cleanup, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { parseGitHubIssueOrPRLink } from '../../../../shared/github/links'
import { NativeChatGitHubPeekBody, resolveGitHubPeekLink } from './NativeChatGitHubLinkPeek'
import type { NativeChatGitHubRepo } from './native-chat-github-repo'
import { repoFixture } from './native-chat-workspace-test-fixtures'

vi.mock('./native-chat-github-link-preview', () => ({
  githubLinkPreviewKey: () => 'key',
  readCachedGitHubLinkPreview: () => null,
  // An older host, or a repo the sign-in can't read, leaves the lookup unanswered.
  loadGitHubLinkPreview: async () => null
}))

const repo = repoFixture({ kind: 'git' })
const githubRepo: NativeChatGitHubRepo = {
  repo,
  identityKeys: ['acme/widgets'],
  referenceRepo: null
}

describe('resolveGitHubPeekLink', () => {
  it('admits any repo on a host the chat repo uses, and tells its own apart', () => {
    expect(
      resolveGitHubPeekLink(githubRepo, 'https://github.com/acme/widgets/pull/1')?.ownRepo
    ).toBe(true)
    expect(resolveGitHubPeekLink(githubRepo, 'https://github.com/other/tools/pull/7')).toEqual({
      link: expect.objectContaining({ number: 7 }),
      ownRepo: false
    })
    expect(
      resolveGitHubPeekLink(githubRepo, 'https://ghe.example.test/acme/widgets/pull/1')
    ).toBeNull()
  })
})

describe('NativeChatGitHubPeekBody', () => {
  const otherLink = parseGitHubIssueOrPRLink('https://github.com/other/tools/pull/7')!

  async function renderAnswered(fallback?: React.ReactNode): Promise<void> {
    render(<NativeChatGitHubPeekBody repo={repo} link={otherLink} otherRepoFallback={fallback} />)
    await act(async () => {})
  }

  it("shows another repo's web preview, or just its name, when the lookup goes unanswered", async () => {
    await renderAnswered(<p>web</p>)
    expect(screen.getByText('web')).toBeTruthy()
    cleanup()
    await renderAnswered(null)
    expect(screen.getByText('other/tools')).toBeTruthy()
    expect(screen.queryByText('Preview unavailable.')).toBeNull()
  })

  it('keeps the failure and its retry for the chat repo itself', async () => {
    await renderAnswered(undefined)
    expect(screen.getByText('Preview unavailable.')).toBeTruthy()
  })
})
