import { describe, expect, it } from 'vitest'
import {
  matchLinkRoute,
  normalizeHostForMatch,
  normalizeRoutePattern,
  rankLinkRoutes,
  type NormalizedLinkRoute
} from './plugin-link-route-matching'

function route(hostname: string, destination: 'orca-browser' | 'system-browser' = 'orca-browser') {
  const pattern = normalizeRoutePattern(hostname)
  if (!pattern) {
    throw new Error(`pattern rejected: ${hostname}`)
  }
  return { pattern, destination, pluginKey: 'pub.plugin', index: 0 } satisfies NormalizedLinkRoute
}

describe('normalizeRoutePattern', () => {
  it('accepts an exact host', () => {
    expect(normalizeRoutePattern('app.loopspark.test')?.kind).toBe('exact')
  })

  it('accepts a single-label wildcard over a registrable domain', () => {
    const pattern = normalizeRoutePattern('*.example.com')
    expect(pattern).toMatchObject({ kind: 'label', tail: 'example.com' })
  })

  it('accepts a mid-label wildcard under a reserved tld', () => {
    const pattern = normalizeRoutePattern('*-loopspark.test')
    expect(pattern).toMatchObject({ kind: 'midlabel', tail: '-loopspark.test' })
  })

  it('lowercases and strips one trailing dot', () => {
    expect(normalizeRoutePattern('APP.Example.COM.')).toMatchObject({
      kind: 'exact',
      host: 'app.example.com'
    })
  })

  it.each([
    ['*', 'bare wildcard'],
    ['*-com', 'tail has fewer than two labels'],
    ['*e.com', 'mid-label wildcard against a public tld'],
    ['*o.uk', 'mid-label wildcard against a public tld'],
    ['*x.test', 'wildcard label literal shorter than the minimum'],
    ['*t.localhost', 'wildcard label literal shorter than the minimum'],
    ['example.com*', 'wildcard not leading'],
    ['*.foo.*.com', 'more than one wildcard'],
    ['app.loopspark.test:8080', 'port'],
    ['https://app.loopspark.test', 'scheme'],
    ['user@example.com', 'userinfo'],
    ['example..com', 'empty label'],
    ['10.0.0.1', 'ipv4 literal'],
    ['[::1]', 'ipv6 literal'],
    ['', 'empty'],
    ['   ', 'whitespace only']
  ])('rejects %s (%s)', (input) => {
    expect(normalizeRoutePattern(input)).toBeNull()
  })

  it('converts unicode to punycode rather than rejecting it', () => {
    // SAFETY-adjacent: the stored form must be ascii so the consent dialog cannot render a homograph.
    const pattern = normalizeRoutePattern('*.pаypal.com')
    expect(pattern?.kind).toBe('label')
    expect(pattern && 'tail' in pattern && pattern.tail).toMatch(/^xn--/)
  })

  it('runs idna before case folding', () => {
    // Greek final sigma folds differently under toLowerCase() than under UTS-46.
    const viaPattern = normalizeRoutePattern('ΟΣ-foobar.test')
    const viaHost = normalizeHostForMatch(new URL('http://ΟΣ-foobar.test').hostname)
    expect(viaPattern).toMatchObject({ kind: 'exact', host: viaHost })
  })
})

describe('matchLinkRoute', () => {
  it('matches the motivating mid-label case across dots', () => {
    const routes = [route('*-loopspark.test')]
    const url = 'https://app.schedule-g-pulse-side-bar-make-fields-editable-loopspark.test/x?y=1#z'
    expect(matchLinkRoute(url, routes)?.destination).toBe('orca-browser')
  })

  it('does not match when the pattern is only a prefix of a longer host', () => {
    expect(
      matchLinkRoute('https://app-loopspark.test.evil.com/', [route('*-loopspark.test')])
    ).toBeNull()
  })

  it('requires the mid-label wildcard to consume at least one character', () => {
    expect(matchLinkRoute('https://loopspark.test/', [route('*-loopspark.test')])).toBeNull()
  })

  it('matches exactly one label for a label wildcard', () => {
    const routes = [route('*.example.com')]
    expect(matchLinkRoute('https://a.example.com/', routes)).not.toBeNull()
    expect(matchLinkRoute('https://a.b.example.com/', routes)).toBeNull()
    expect(matchLinkRoute('https://example.com/', routes)).toBeNull()
  })

  it('cannot cross a public suffix below the literal tail', () => {
    // The validator cannot see s3.amazonaws.com below the tail; single-label matching is the guard.
    expect(
      matchLinkRoute('https://victim-bucket.s3.amazonaws.com/', [route('*.amazonaws.com')])
    ).toBeNull()
  })

  it('does not treat a hyphenated neighbour as a subdomain', () => {
    expect(matchLinkRoute('https://evil-example.com/', [route('*.example.com')])).toBeNull()
  })

  it('matches case-insensitively and tolerates a trailing dot', () => {
    const routes = [route('*-loopspark.test')]
    expect(matchLinkRoute('https://APP-LOOPSPARK.TEST/', routes)).not.toBeNull()
    expect(matchLinkRoute('https://app-loopspark.test./', routes)).not.toBeNull()
  })

  it('reads the host from the url, defeating userinfo tricks', () => {
    expect(
      matchLinkRoute('https://app-loopspark.test@evil.com/', [route('*-loopspark.test')])
    ).toBeNull()
  })

  it('refuses to route credential-bearing urls', () => {
    expect(
      matchLinkRoute('https://u:p@app-loopspark.test/', [route('*-loopspark.test')])
    ).toBeNull()
  })

  it.each([
    'ftp://app-loopspark.test/',
    'file:///tmp/x',
    'mailto:a@app-loopspark.test',
    'javascript:alert(1)'
  ])('ignores non-http(s) url %s', (url) => {
    expect(matchLinkRoute(url, [route('*-loopspark.test')])).toBeNull()
  })

  it('never matches an ip literal against a wildcard', () => {
    const routes = [route('*.example.com')]
    for (const url of [
      'http://[::1]:3000/',
      'http://127.1/',
      'http://2130706433/',
      'http://0x7f.1/'
    ]) {
      expect(matchLinkRoute(url, routes)).toBeNull()
    }
  })

  it('returns null rather than throwing on an unparseable url', () => {
    expect(matchLinkRoute('not a url', [route('*.example.com')])).toBeNull()
  })

  it('ignores port, path, query and fragment when matching', () => {
    const routes = [route('app.example.com')]
    expect(matchLinkRoute('https://app.example.com:8443/a/b?c=d#e', routes)).not.toBeNull()
  })
})

describe('rankLinkRoutes', () => {
  it('prefers exact over wildcard, then longer tail, then plugin key, then index', () => {
    const exact: NormalizedLinkRoute = { ...route('app-loopspark.test'), pluginKey: 'z.z' }
    const long: NormalizedLinkRoute = { ...route('*-api-loopspark.test'), pluginKey: 'a.a' }
    const short: NormalizedLinkRoute = { ...route('*-loopspark.test'), pluginKey: 'a.a' }
    const ranked = rankLinkRoutes([short, long, exact])
    expect(ranked.map((r) => r.pattern.kind)).toEqual(['exact', 'midlabel', 'midlabel'])
    expect(ranked[1]).toBe(long)
  })

  it('is stable regardless of input order', () => {
    const a: NormalizedLinkRoute = { ...route('*-loopspark.test'), pluginKey: 'a.a', index: 0 }
    const b: NormalizedLinkRoute = { ...route('*-loopspark.test'), pluginKey: 'a.a', index: 1 }
    expect(rankLinkRoutes([a, b])).toEqual(rankLinkRoutes([b, a]))
  })
})
