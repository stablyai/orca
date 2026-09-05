import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildPackageJsonDependencyHoverMarkdown } from './package-json-dependency-hover-markdown'
import type {
  NpmPackageInfo,
  NpmPackageInfoResult
} from '../../../../shared/npm-package-info-types'

function okResult(overrides: Partial<NpmPackageInfo> = {}): NpmPackageInfoResult {
  return {
    status: 'ok',
    info: {
      packageName: 'react',
      description: null,
      latestVersion: null,
      latestPublishedAt: null,
      homepageUrl: null,
      repositoryUrl: null,
      source: 'npm-cli',
      ...overrides
    }
  }
}

/** Asserts a hover was produced; the null case has its own tests below. */
function buildMarkdown(
  params: Parameters<typeof buildPackageJsonDependencyHoverMarkdown>[0]
): string {
  const markdown = buildPackageJsonDependencyHoverMarkdown(params)
  if (markdown === null) {
    throw new Error('expected hover markdown, got null')
  }
  return markdown
}

describe('buildPackageJsonDependencyHoverMarkdown', () => {
  it('renders the installed version when the package is installed', () => {
    const markdown = buildMarkdown({
      packageName: 'react',
      installedVersion: { status: 'installed', version: '19.0.0' },
      result: okResult()
    })

    expect(markdown).toContain('react')
    expect(markdown).toContain('19.0.0')
  })

  it('renders "not installed" when the package has no local install', () => {
    const markdown = buildMarkdown({
      packageName: 'react',
      installedVersion: { status: 'not-installed' },
      result: okResult()
    })

    expect(markdown.toLowerCase()).toContain('not installed')
  })

  it('escapes registry-supplied description text and never renders it as a link', () => {
    const markdown = buildMarkdown({
      packageName: 'react',
      installedVersion: { status: 'not-installed' },
      result: okResult({ description: '[click](javascript:alert(1))' })
    })

    expect(markdown).not.toContain('](javascript:alert')
    expect(markdown).toContain('\\[click\\]')
  })

  it('renders the homepage as a clickable link only when https', () => {
    const markdownHttps = buildMarkdown({
      packageName: 'react',
      installedVersion: { status: 'not-installed' },
      result: okResult({ homepageUrl: 'https://react.dev' })
    })
    expect(markdownHttps).toContain('(https://react.dev)')

    const markdownHttp = buildMarkdown({
      packageName: 'react',
      installedVersion: { status: 'not-installed' },
      result: okResult({ homepageUrl: 'http://react.dev' as never })
    })
    expect(markdownHttp).not.toContain('http://react.dev')
  })

  it('distinguishes patch drift from major drift', () => {
    const patchMarkdown = buildMarkdown({
      packageName: 'react',
      installedVersion: { status: 'installed', version: '1.2.3' },
      result: okResult({ latestVersion: '1.2.9' })
    })
    const majorMarkdown = buildMarkdown({
      packageName: 'react',
      installedVersion: { status: 'installed', version: '1.0.0' },
      result: okResult({ latestVersion: '3.0.0' })
    })

    expect(patchMarkdown).not.toEqual(majorMarkdown)
    expect(patchMarkdown.toLowerCase()).toContain('patch')
    expect(majorMarkdown.toLowerCase()).toContain('major')
  })

  it('does not flag equal installed and latest versions as outdated', () => {
    const markdown = buildMarkdown({
      packageName: 'react',
      installedVersion: { status: 'installed', version: '1.2.3' },
      result: okResult({ latestVersion: '1.2.3' })
    })

    expect(markdown.toLowerCase()).not.toContain('update available')
  })

  it('renders a non-semver installed version as plain text with no outdated marker', () => {
    const markdown = buildMarkdown({
      packageName: 'react',
      installedVersion: { status: 'installed', version: 'workspace:*' },
      result: okResult({ latestVersion: '19.0.0' })
    })

    expect(markdown).toMatch(/workspace:\\?\*/)
    expect(markdown.toLowerCase()).not.toContain('update available')
  })

  describe('latest version publish date', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('renders a relative wording for a recent publish timestamp', () => {
      const markdown = buildMarkdown({
        packageName: 'react',
        installedVersion: { status: 'installed', version: '19.0.0' },
        result: okResult({
          latestVersion: '19.1.0',
          latestPublishedAt: '2025-12-31T23:55:00.000Z'
        })
      })

      expect(markdown).toContain('5 minutes ago')
      expect(markdown).not.toContain('2025-12-31T23:55:00.000Z')
      expect(markdown).not.toMatch(/auto\.components\.editor/)
    })

    it('renders a relative wording for an old publish timestamp instead of leaking the raw key or ISO string', () => {
      const markdown = buildMarkdown({
        packageName: 'react',
        installedVersion: { status: 'installed', version: '19.0.0' },
        result: okResult({
          latestVersion: '19.1.0',
          latestPublishedAt: '2025-12-02T00:00:00.000Z'
        })
      })

      expect(markdown).toContain('30 days ago')
      expect(markdown).not.toContain('2025-12-02T00:00:00.000Z')
      expect(markdown).not.toMatch(/auto\.components\.editor/)
    })
  })
})

describe('never explains what it could not fetch', () => {
  // Why: VS Code's npm extension returns no hover at all when a lookup yields
  // nothing (`getInfoContribution` → `null`), and synthesizes a minimal record
  // when only the installed version is known. Saying "not found on the npm
  // registry" to someone whose package lives on a private registry is worse
  // than saying nothing: the package exists, we simply never asked its host.
  it.each([['not-found' as const], ['unavailable' as const], ['lookup-disabled' as const]])(
    'shows the installed version alone for %s, with no failure wording',
    (status) => {
      const markdown = buildMarkdown({
        packageName: '@acme/design-system',
        installedVersion: { status: 'installed', version: '2.4.0' },
        result: status === 'unavailable' ? { status, reason: 'network' } : { status }
      })

      expect(markdown).toContain('2.4.0')
      expect(markdown).not.toMatch(/not found|disabled|Could not complete/i)
    }
  )

  it.each([['not-found' as const], ['unavailable' as const], ['lookup-disabled' as const]])(
    'renders no hover for %s when nothing at all is known',
    (status) => {
      const markdown = buildPackageJsonDependencyHoverMarkdown({
        packageName: '@acme/design-system',
        installedVersion: { status: 'not-installed' },
        result: status === 'unavailable' ? { status, reason: 'network' } : { status }
      })

      expect(markdown).toBeNull()
    }
  )
})

describe('buildPackageJsonDependencyHoverMarkdown source attribution', () => {
  // Why nothing is rendered: this hover never explains what it could not
  // reach. `sourceReason` exists for diagnostics and tests; surfacing "read
  // from the public registry because this workspace is untrusted" would put
  // back exactly the failure copy this hover deliberately does without.
  it('never mentions the reason a result fell back to the public registry', () => {
    const markdown = buildMarkdown({
      packageName: 'react',
      installedVersion: { status: 'installed', version: '19.0.0' },
      result: okResult({
        latestVersion: '19.1.0',
        source: 'registry-http',
        sourceReason: 'workspace-untrusted'
      })
    })

    expect(markdown).not.toContain('workspace-untrusted')
    expect(markdown).not.toMatch(/trust/i)
    expect(markdown).not.toMatch(/registry/i)
  })

  it('renders a trusted npm-cli result identically to an untrusted registry one', () => {
    const params = {
      packageName: 'react',
      installedVersion: { status: 'installed' as const, version: '19.0.0' }
    }

    expect(buildMarkdown({ ...params, result: okResult({ latestVersion: '19.1.0' }) })).toBe(
      buildMarkdown({
        ...params,
        result: okResult({
          latestVersion: '19.1.0',
          source: 'registry-http',
          sourceReason: 'npm-unavailable'
        })
      })
    )
  })
})

/**
 * The description is the only block emitted without a prefix and it preserves the
 * registry's own newlines, so a line-leading list marker would render as a list.
 */
describe('description block list-marker containment', () => {
  it.each([
    ['- first\n- second', '\\- first\n\\- second'],
    ['1. first\n2. second', '1\\. first\n2\\. second'],
    ['  - indented', '  \\- indented'],
    ['--- rule', '\\--- rule']
  ])('escapes the leading list marker in %j', (description, expected) => {
    const markdown = buildMarkdown({
      packageName: 'react',
      installedVersion: { status: 'not-installed' },
      result: okResult({ description })
    })

    expect(markdown).toContain(expected)
  })

  // Why: `.` and `-` carry no markdown meaning mid-line, and escaping them there
  // would mangle an ordinary version number or a hyphenated word.
  it.each([
    'Runs on Node 19.0.0 and later',
    'A well-known state-management library',
    'Supports semver ranges like ^1.2.3'
  ])('leaves the mid-line text of %j untouched', (description) => {
    const markdown = buildMarkdown({
      packageName: 'react',
      installedVersion: { status: 'not-installed' },
      result: okResult({ description })
    })

    expect(markdown).toContain(description)
  })
})
