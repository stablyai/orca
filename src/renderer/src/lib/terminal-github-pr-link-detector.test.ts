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

  it('ignores non-PR and non-GitHub links', () => {
    const observe = createTerminalGitHubPRLinkDetector()

    expect(
      observe(
        'https://github.com/acme/orca/issues/42 https://github.example.com/acme/orca/pull/42\n'
      )
    ).toEqual([])
  })
})
