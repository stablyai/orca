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
        slug: { owner: 'acme', repo: 'orca', host: 'github.com' },
        number: 42
      }
    ])
  })

  it('detects issue 8126 Claude Code PR links with attached ANSI reset', () => {
    const observe = createTerminalGitHubPRLinkDetector()

    expect(observe(`${issue8126Url}\x1b[22m\n`)).toEqual([
      {
        url: issue8126Url,
        slug: { owner: 'owner', repo: 'repo', host: 'github.com' },
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
        slug: { owner: 'owner', repo: 'repo', host: 'github.com' },
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
        slug: { owner: 'MyOrg', repo: 'my_repo', host: 'github.my-company.net' },
        number: 395
      }
    ])
  })

  it('extracts HTTP GitHub Enterprise pull request URLs from terminal output', () => {
    const observe = createTerminalGitHubPRLinkDetector()

    expect(observe('Created http://github.internal/MyOrg/my_repo/pull/395\r\n')).toEqual([
      {
        url: 'http://github.internal/MyOrg/my_repo/pull/395',
        slug: { owner: 'MyOrg', repo: 'my_repo', host: 'github.internal' },
        number: 395
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

  it('scans huge terminal chunks containing pull markers without global regex iteration', () => {
    const matchAll = vi.spyOn(String.prototype, 'matchAll')
    const observe = createTerminalGitHubPRLinkDetector()
    const noise = `${'/pull/not-a-url '.repeat(20_000)}\n`

    expect(observe(`${noise}Created https://github.com/acme/orca/pull/42\r\n`)).toEqual([
      {
        url: 'https://github.com/acme/orca/pull/42',
        slug: { owner: 'acme', repo: 'orca', host: 'github.com' },
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

  // Why: the carry scan only looks at the trailing MAX_CARRY_LENGTH (512) bytes,
  // so these pin both sides of that cap and the drop arm behind it.
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

  it('drops carry when the scheme sits further back than the carry cap', () => {
    const observe = createTerminalGitHubPRLinkDetector()

    // The URL opened >512 bytes before the chunk end, so it already overran the
    // cap and must not resurrect on the next chunk.
    expect(observe(`https://github.com/acme/orca/pull/${'4'.repeat(600)}`)).toEqual([])
    expect(observe('2\r\n')).toEqual([])
  })

  it('keeps carry when the scheme-to-end tail is exactly at the cap', () => {
    const observe = createTerminalGitHubPRLinkDetector()

    // Scheme-to-end tail is exactly MAX_CARRY_LENGTH, so the carry survives and
    // the URL joins on the next chunk. Shrinking the window by one byte drops it.
    // Padding goes in the repo segment so the trailing PR number stays finite.
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

  it('does not fabricate a link by splicing a stale fragment onto later output', () => {
    const observe = createTerminalGitHubPRLinkDetector()

    // Keeping the 'h' would splice it onto the next chunk and emit a PR link for
    // a repo that never appeared in the stream.
    expect(observe(`https://github.com/acme/orca/pull/1${'x'.repeat(600)}h`)).toEqual([])
    expect(observe('ttps://github.com/zz/yy/pull/9\n')).toEqual([])
  })

  // Why both schemes: the carry scan checks every entry of HTTP_SCHEME_PREFIXES,
  // so http:// needs its own carry coverage or half the loop goes unpinned.
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

  it('drops a trailing fragment when a plain http:// scheme sits behind the window', () => {
    const observe = createTerminalGitHubPRLinkDetector()

    expect(observe(`http://github.internal/o/r/pull/1${'x'.repeat(600)}https`)).toEqual([])
    expect(observe('://github.com/a/b/pull/12\n')).toEqual([])
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
