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

  // Pin both sides of the 512-character carry cap and the overlong-URL drop path.
  it('still joins a PR URL split across chunks after a large scheme-free chunk', () => {
    const observe = createTerminalGitHubPRLinkDetector()

    expect(observe(`${'filler output\n'.repeat(5_000)}https://github.com/acme/orca/pull/`)).toEqual(
      []
    )
    expect(observe('7\r\n')).toEqual([
      {
        url: 'https://github.com/acme/orca/pull/7',
        slug: { owner: 'acme', repo: 'orca', host: 'github.com' },
        number: 7
      }
    ])
  })

  it('keeps carry when the scheme-to-end tail is exactly at the cap', () => {
    const observe = createTerminalGitHubPRLinkDetector()

    // Exactly at the cap, the carry must survive. Pad the repo segment to keep the PR number finite.
    const stem = `https://github.com/acme/${'r'.repeat(481)}/pull/7`
    expect(stem).toHaveLength(512)
    expect(observe(`noise\n${stem}`)).toEqual([])
    expect(observe('\n')).toEqual([
      {
        url: stem,
        slug: { owner: 'acme', repo: 'r'.repeat(481), host: 'github.com' },
        number: 7
      }
    ])
  })

  it('drops carry one byte past the cap', () => {
    const observe = createTerminalGitHubPRLinkDetector()

    // One byte longer than the cap, so the carry is abandoned and nothing joins.
    const stem = `https://github.com/acme/${'r'.repeat(482)}/pull/7`
    expect(stem).toHaveLength(513)
    expect(observe(`noise\n${stem}`)).toEqual([])
    expect(observe('\n')).toEqual([])
  })

  it('drops a trailing scheme fragment when a scheme sits behind the window', () => {
    const observe = createTerminalGitHubPRLinkDetector()

    // The earlier scheme already overran the cap, so the trailing 'https'
    // fragment must not restart a carry and revive the abandoned URL.
    expect(observe(`https://github.com/acme/orca/pull/1${'x'.repeat(600)}https`)).toEqual([])
    expect(observe('://github.com/acme/orca/pull/12\n')).toEqual([])
  })

  it('joins a plain http:// PR URL split across chunks', () => {
    const observe = createTerminalGitHubPRLinkDetector()

    expect(observe('http://github.internal/MyOrg/my_repo/pull/39')).toEqual([])
    expect(observe('5\r\n')).toEqual([
      {
        url: 'http://github.internal/MyOrg/my_repo/pull/395',
        slug: { owner: 'MyOrg', repo: 'my_repo', host: 'github.internal' },
        number: 395
      }
    ])
  })

  it('keeps a trailing scheme fragment when no scheme sits behind the window', () => {
    const observe = createTerminalGitHubPRLinkDetector()

    expect(observe(`${'x'.repeat(1_000)}https`)).toEqual([])
    expect(observe('://github.com/acme/orca/pull/12\n')).toEqual([
      {
        url: 'https://github.com/acme/orca/pull/12',
        slug: { owner: 'acme', repo: 'orca', host: 'github.com' },
        number: 12
      }
    ])
  })
})
