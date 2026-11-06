// @vitest-environment happy-dom

import { act, cleanup, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { parseGitHubIssueOrPRLink } from '../../../../shared/github/links'
import { NativeChatGitHubPeekBody, resolveGitHubPeekLink } from './NativeChatGitHubLinkPeek'
import type { NativeChatGitHubRepo } from './native-chat-github-repo'
import { repoFixture } from './native-chat-workspace-test-fixtures'

const lookup = vi.hoisted(() => ({ answer: vi.fn() }))

vi.mock('./native-chat-github-link-preview', () => ({
  githubLinkPreviewKey: () => 'key',
  readCachedGitHubLinkPreview: () => null,
  loadGitHubLinkPreview: () => lookup.answer()
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
  const view = (fallback?: React.ReactNode) =>
    render(<NativeChatGitHubPeekBody repo={repo} link={otherLink} otherRepoFallback={fallback} />)

  it("keeps another repo's web preview until its details arrive, and through no answer", async () => {
    let answer: (item: unknown) => void = () => {}
    lookup.answer.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    view(<p>web</p>)
    expect(screen.getByText('web')).toBeTruthy()
    await act(async () => answer({ type: 'pr', title: 'Tools PR', state: 'open', labels: [] }))
    expect(screen.getByText('Tools PR')).toBeTruthy()
    cleanup()

    // An older host, or a repo the sign-in can't read, leaves the lookup unanswered.
    lookup.answer.mockResolvedValue(null)
    view(<p>web</p>)
    await act(async () => {})
    expect(screen.getByText('web')).toBeTruthy()
  })

  it('shows just the name when there is no web preview, but keeps the failure for the chat repo', async () => {
    // The same card while pending as after no answer: just the name, no skeleton to collapse.
    let answer: (item: unknown) => void = () => {}
    lookup.answer.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    const { container } = view(null)
    const pending = container.innerHTML
    expect(screen.getByText('other/tools')).toBeTruthy()
    await act(async () => answer(null))
    expect(container.innerHTML).toBe(pending)
    expect(screen.queryByText('Preview unavailable.')).toBeNull()
    cleanup()
    view(undefined)
    await act(async () => {})
    expect(screen.getByText('Preview unavailable.')).toBeTruthy()
  })
})
