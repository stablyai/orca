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

describe('buildPackageJsonDependencyHoverMarkdown', () => {
  it('renders the installed version when the package is installed', () => {
    const markdown = buildPackageJsonDependencyHoverMarkdown({
      packageName: 'react',
      installedVersion: { status: 'installed', version: '19.0.0' },
      result: okResult()
    })

    expect(markdown).toContain('react')
    expect(markdown).toContain('19.0.0')
  })

  it('renders "not installed" when the package has no local install', () => {
    const markdown = buildPackageJsonDependencyHoverMarkdown({
      packageName: 'react',
      installedVersion: { status: 'not-installed' },
      result: okResult()
    })

    expect(markdown.toLowerCase()).toContain('not installed')
  })

  it('escapes registry-supplied description text and never renders it as a link', () => {
    const markdown = buildPackageJsonDependencyHoverMarkdown({
      packageName: 'react',
      installedVersion: { status: 'not-installed' },
      result: okResult({ description: '[click](javascript:alert(1))' })
    })

    expect(markdown).not.toContain('](javascript:alert')
    expect(markdown).toContain('\\[click\\]')
  })

  it('renders the homepage as a clickable link only when https', () => {
    const markdownHttps = buildPackageJsonDependencyHoverMarkdown({
      packageName: 'react',
      installedVersion: { status: 'not-installed' },
      result: okResult({ homepageUrl: 'https://react.dev' })
    })
    expect(markdownHttps).toContain('(https://react.dev)')

    const markdownHttp = buildPackageJsonDependencyHoverMarkdown({
      packageName: 'react',
      installedVersion: { status: 'not-installed' },
      result: okResult({ homepageUrl: 'http://react.dev' as never })
    })
    expect(markdownHttp).not.toContain('http://react.dev')
  })

  it('distinguishes patch drift from major drift', () => {
    const patchMarkdown = buildPackageJsonDependencyHoverMarkdown({
      packageName: 'react',
      installedVersion: { status: 'installed', version: '1.2.3' },
      result: okResult({ latestVersion: '1.2.9' })
    })
    const majorMarkdown = buildPackageJsonDependencyHoverMarkdown({
      packageName: 'react',
      installedVersion: { status: 'installed', version: '1.0.0' },
      result: okResult({ latestVersion: '3.0.0' })
    })

    expect(patchMarkdown).not.toEqual(majorMarkdown)
    expect(patchMarkdown.toLowerCase()).toContain('patch')
    expect(majorMarkdown.toLowerCase()).toContain('major')
  })

  it('does not flag equal installed and latest versions as outdated', () => {
    const markdown = buildPackageJsonDependencyHoverMarkdown({
      packageName: 'react',
      installedVersion: { status: 'installed', version: '1.2.3' },
      result: okResult({ latestVersion: '1.2.3' })
    })

    expect(markdown.toLowerCase()).not.toContain('update available')
  })

  it('renders a non-semver installed version as plain text with no outdated marker', () => {
    const markdown = buildPackageJsonDependencyHoverMarkdown({
      packageName: 'react',
      installedVersion: { status: 'installed', version: 'workspace:*' },
      result: okResult({ latestVersion: '19.0.0' })
    })

    expect(markdown).toMatch(/workspace:\\?\*/)
    expect(markdown.toLowerCase()).not.toContain('update available')
  })

  it('renders three distinguishable messages for not-found, lookup-disabled, and unavailable', () => {
    const notFound = buildPackageJsonDependencyHoverMarkdown({
      packageName: 'react',
      installedVersion: { status: 'not-installed' },
      result: { status: 'not-found' }
    })
    const disabled = buildPackageJsonDependencyHoverMarkdown({
      packageName: 'react',
      installedVersion: { status: 'not-installed' },
      result: { status: 'lookup-disabled' }
    })
    const unavailable = buildPackageJsonDependencyHoverMarkdown({
      packageName: 'react',
      installedVersion: { status: 'not-installed' },
      result: { status: 'unavailable', reason: 'timeout' }
    })

    const messages = new Set([notFound, disabled, unavailable])
    expect(messages.size).toBe(3)
  })

  it('still shows the installed version alongside a lookup-disabled message', () => {
    const markdown = buildPackageJsonDependencyHoverMarkdown({
      packageName: 'react',
      installedVersion: { status: 'installed', version: '19.0.0' },
      result: { status: 'lookup-disabled' }
    })

    expect(markdown).toContain('19.0.0')
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
      const markdown = buildPackageJsonDependencyHoverMarkdown({
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
      const markdown = buildPackageJsonDependencyHoverMarkdown({
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
