import { describe, expect, it } from 'vitest'
import { createTerminalGitHubPRLinkDetector } from './terminal-github-pr-link-detector'

describe('createTerminalGitHubPRLinkDetector', () => {
  it('extracts GitHub pull request URLs from terminal output', () => {
    const observe = createTerminalGitHubPRLinkDetector()

    expect(observe('Created https://github.com/acme/orca/pull/42\r\n')).toEqual([
      {
        url: 'https://github.com/acme/orca/pull/42',
        slug: { owner: 'acme', repo: 'orca' },
        number: 42
      }
    ])
  })

  it('waits for a boundary when the URL is split across PTY chunks', () => {
    const observe = createTerminalGitHubPRLinkDetector()

    expect(observe('https://github.com/acme/orca/pull/4')).toEqual([])
    expect(observe('2\r\n')).toEqual([
      {
        url: 'https://github.com/acme/orca/pull/42',
        slug: { owner: 'acme', repo: 'orca' },
        number: 42
      }
    ])
  })

  it('detects a URL split inside the GitHub prefix', () => {
    const observe = createTerminalGitHubPRLinkDetector()

    expect(observe('created https://gith')).toEqual([])
    expect(observe('ub.com/acme/orca/pull/42\n')).toEqual([
      {
        url: 'https://github.com/acme/orca/pull/42',
        slug: { owner: 'acme', repo: 'orca' },
        number: 42
      }
    ])
  })

  it('trims terminal punctuation around printed URLs', () => {
    const observe = createTerminalGitHubPRLinkDetector()

    expect(observe('Opened (https://github.com/acme/orca/pull/42).\n')[0]?.url).toBe(
      'https://github.com/acme/orca/pull/42'
    )
  })

  it('does not repeat the same PR URL from overlapping carry text', () => {
    const observe = createTerminalGitHubPRLinkDetector()

    expect(observe('https://github.com/acme/orca/pull/42\n')).toHaveLength(1)
    expect(observe('more output\n')).toEqual([])
  })

  it('ignores non-PR GitHub-shaped links', () => {
    const observe = createTerminalGitHubPRLinkDetector()

    expect(observe('https://github.com/acme/orca/issues/42\n')).toEqual([])
  })

  it('extracts GitHub Enterprise pull request URLs from terminal output', () => {
    const observe = createTerminalGitHubPRLinkDetector()

    expect(observe('Created https://github.my-company.net/MyOrg/my_repo/pull/395\r\n')).toEqual([
      {
        url: 'https://github.my-company.net/MyOrg/my_repo/pull/395',
        slug: { owner: 'MyOrg', repo: 'my_repo' },
        number: 395
      }
    ])
  })

  it('extracts HTTP GitHub Enterprise pull request URLs from terminal output', () => {
    const observe = createTerminalGitHubPRLinkDetector()

    expect(observe('Created http://github.internal/MyOrg/my_repo/pull/395\r\n')).toEqual([
      {
        url: 'http://github.internal/MyOrg/my_repo/pull/395',
        slug: { owner: 'MyOrg', repo: 'my_repo' },
        number: 395
      }
    ])
  })

  it('extracts GitHub Enterprise pull request URLs with a custom port', () => {
    const observe = createTerminalGitHubPRLinkDetector()

    expect(observe('Created https://github.internal:8443/MyOrg/my_repo/pull/397\r\n')).toEqual([
      {
        url: 'https://github.internal:8443/MyOrg/my_repo/pull/397',
        slug: { owner: 'MyOrg', repo: 'my_repo' },
        number: 397
      }
    ])
  })
})
