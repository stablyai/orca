import { describe, expect, it } from 'vitest'
import { createTerminalGitHubPRLinkDetector } from './terminal-github-pr-link-detector'

const issue8126Url = 'https://github.com/owner/repo/pull/10'

describe('createTerminalGitHubPRLinkDetector', () => {
  it('skips nested schemes and continues through mixed HTTP and HTTPS candidates', () => {
    const observe = createTerminalGitHubPRLinkDetector()
    const urls = [
      'https://github.com/acme/orca/pull/1',
      'http://github.internal/acme/orca/pull/2',
      'https://github.com/acme/orca/pull/3'
    ]
    const output = [
      'https://example.com/redirect?to=http://github.com/acme/orca/pull/99',
      ...urls,
      ''
    ].join('\n')

    expect(observe(output).map((link) => link.url)).toEqual(urls)
  })

  it('strips an ANSI reset split across PTY chunks', () => {
    const observe = createTerminalGitHubPRLinkDetector()

    expect(observe(`${issue8126Url}\x1b`)).toEqual([])
    expect(observe('[22m\n')).toEqual([
      {
        url: issue8126Url,
        slug: { owner: 'owner', repo: 'repo', host: 'github.com' },
        number: 10
      }
    ])
  })

  it('does not fuse screen-editing controls into PR URLs', () => {
    for (const screenEdit of ['\x08', '\x0b', '\x0c', '\x1bD', '\x1b[2J', '\x1b[2K', '\x1b[1S']) {
      const observe = createTerminalGitHubPRLinkDetector()

      expect(observe(`https://github.com/owner/repo/pull/1${screenEdit}0\n`)).toEqual([])
    }
  })

  it('deduplicates styled and plain instances', () => {
    const observe = createTerminalGitHubPRLinkDetector()

    expect(observe(`${issue8126Url}\x1b[22m\n${issue8126Url}\n`)).toEqual([
      {
        url: issue8126Url,
        slug: { owner: 'owner', repo: 'repo', host: 'github.com' },
        number: 10
      }
    ])
  })

  it('waits for a boundary when the URL is split across PTY chunks', () => {
    const observe = createTerminalGitHubPRLinkDetector()

    expect(observe('https://github.com/acme/orca/pull/4')).toEqual([])
    expect(observe('2\r\n')).toEqual([
      {
        url: 'https://github.com/acme/orca/pull/42',
        slug: { owner: 'acme', repo: 'orca', host: 'github.com' },
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
        slug: { owner: 'acme', repo: 'orca', host: 'github.com' },
        number: 42
      }
    ])
  })

  it('extracts GitHub Enterprise pull request URLs with a custom port', () => {
    const observe = createTerminalGitHubPRLinkDetector()

    expect(observe('Created https://github.internal:8443/MyOrg/my_repo/pull/397\r\n')).toEqual([
      {
        url: 'https://github.internal:8443/MyOrg/my_repo/pull/397',
        // Why: GHES on a non-default port needs the port in its host identity.
        slug: { owner: 'MyOrg', repo: 'my_repo', host: 'github.internal:8443' },
        number: 397
      }
    ])
  })

  it('drops a trailing scheme fragment when a scheme sits behind the window', () => {
    const observe = createTerminalGitHubPRLinkDetector()

    // The earlier scheme already overran the cap, so the trailing 'https'
    // fragment must not restart a carry and revive the abandoned URL.
    expect(observe(`https://github.com/acme/orca/pull/1${'x'.repeat(600)}https`)).toEqual([])
    expect(observe('://github.com/acme/orca/pull/12\n')).toEqual([])
  })
})
