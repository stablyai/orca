import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTerminalGitHubPRLinkDetector } from './terminal-github-pr-link-detector'

const issue8126Url = 'https://github.com/owner/repo/pull/10'

afterEach(() => {
  vi.restoreAllMocks()
})

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

  it('detects issue 8126 Claude Code PR links with attached ANSI reset', () => {
    const observe = createTerminalGitHubPRLinkDetector()

    expect(observe(`${issue8126Url}\x1b[22m\n`)).toEqual([
      {
        url: issue8126Url,
        slug: { owner: 'owner', repo: 'repo' },
        number: 10
      }
    ])
  })

  it('strips an ANSI reset split across PTY chunks', () => {
    const observe = createTerminalGitHubPRLinkDetector()

    expect(observe(`${issue8126Url}\x1b`)).toEqual([])
    expect(observe('[22m\n')).toEqual([
      {
        url: issue8126Url,
        slug: { owner: 'owner', repo: 'repo' },
        number: 10
      }
    ])
  })

  it('rejects PR URLs corrupted by cursor movement', () => {
    const observe = createTerminalGitHubPRLinkDetector()

    expect(observe('https://github.com/owne\x1b[1Cr/repo/pull/10\n')).toEqual([])
  })

  it('rejects PR URLs fused across terminal rows', () => {
    for (const cursorMove of ['\x1b[1A', '\x1b[1B']) {
      const observe = createTerminalGitHubPRLinkDetector()

      expect(observe(`https://github.com/owner/repo/pull/${cursorMove}10\n`)).toEqual([])
    }
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
        slug: { owner: 'owner', repo: 'repo' },
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

  it('scans huge terminal chunks containing pull markers without global regex iteration', () => {
    const matchAll = vi.spyOn(String.prototype, 'matchAll')
    const observe = createTerminalGitHubPRLinkDetector()
    const noise = `${'/pull/not-a-url '.repeat(20_000)}\n`

    expect(observe(`${noise}Created https://github.com/acme/orca/pull/42\r\n`)).toEqual([
      {
        url: 'https://github.com/acme/orca/pull/42',
        slug: { owner: 'acme', repo: 'orca' },
        number: 42
      }
    ])
    expect(matchAll).not.toHaveBeenCalled()
  })

  it('drops overlong incomplete URL carry instead of retaining pasted megabytes', () => {
    const observe = createTerminalGitHubPRLinkDetector()

    expect(observe(`https://github.com/acme/orca/pull/${'4'.repeat(10_000)}`)).toEqual([])
    expect(observe('2\r\n')).toEqual([])
  })
})
