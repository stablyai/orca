import { translate } from '@/i18n/i18n'
import { formatUiRelativeTimeFromDate } from '@/i18n/relative-time-format'
import { classifyNpmVersionDrift } from '../../../../shared/npm-version-drift'
import type { NpmPackageInfoResult } from '../../../../shared/npm-package-info-types'
import type { InstalledPackageVersionResult } from './package-json-installed-version'

// Why: `.` and `-` are only markdown-significant at the start of a line (list
// markers); escaping them mid-line would mangle ordinary version numbers
// like `19.0.0` for no safety benefit, since every line here is prefixed.
const MARKDOWN_ESCAPE_PATTERN = /[\\`*_{}[\]()#+!|>~]/g

function escapeMarkdownText(value: string): string {
  return value.replace(MARKDOWN_ESCAPE_PATTERN, (char) => `\\${char}`)
}

/** Only an `https:` URL renders as a clickable link; anything else is dropped. */
function toSafeHttpsLink(url: string | null): string | null {
  if (!url) {
    return null
  }
  try {
    return new URL(url).protocol === 'https:' ? url.replaceAll(')', '%29') : null
  } catch {
    return null
  }
}

function driftSeverityLabel(installed: string, latest: string): string | null {
  switch (classifyNpmVersionDrift(installed, latest)) {
    case 'major':
      return translate(
        'auto.components.editor.PackageJsonDependencyHoverMarkdown.c3f3a43d24',
        'Major update available'
      )
    case 'minor':
      return translate(
        'auto.components.editor.PackageJsonDependencyHoverMarkdown.fe70f0740d',
        'Minor update available'
      )
    case 'patch':
      return translate(
        'auto.components.editor.PackageJsonDependencyHoverMarkdown.7776f659ae',
        'Patch update available'
      )
    case 'same':
    case 'unknown':
    case 'prerelease':
      return null
  }
}

function buildInstalledLine(installedVersion: InstalledPackageVersionResult): string {
  const label = translate(
    'auto.components.editor.PackageJsonDependencyHoverMarkdown.d3f501d912',
    'Installed'
  )
  const notInstalled = translate(
    'auto.components.editor.PackageJsonDependencyHoverMarkdown.5107bd60a9',
    'Not installed'
  )
  const value =
    installedVersion.status === 'installed'
      ? escapeMarkdownText(installedVersion.version)
      : notInstalled
  return `- ${label}: ${value}`
}

function buildLinkLine(labelKey: string, fallback: string, url: string | null): string | null {
  const safeUrl = toSafeHttpsLink(url)
  if (!safeUrl) {
    return null
  }
  return `- [${escapeMarkdownText(translate(labelKey, fallback))}](${safeUrl})`
}

function buildOkResultLines(
  info: Extract<NpmPackageInfoResult, { status: 'ok' }>['info'],
  installedVersion: InstalledPackageVersionResult
): string[] {
  const lines: string[] = []
  if (info.description) {
    lines.push(escapeMarkdownText(info.description))
  }
  if (info.latestVersion) {
    const latestLabel = translate(
      'auto.components.editor.PackageJsonDependencyHoverMarkdown.20c64d5223',
      'Latest'
    )
    const publishedAt = info.latestPublishedAt
      ? ` (${formatUiRelativeTimeFromDate(info.latestPublishedAt)})`
      : ''
    lines.push(`- ${latestLabel}: ${escapeMarkdownText(info.latestVersion)}${publishedAt}`)
    if (installedVersion.status === 'installed') {
      const severity = driftSeverityLabel(installedVersion.version, info.latestVersion)
      if (severity) {
        lines.push(`- ${severity}`)
      }
    }
  }
  const homepageLine = buildLinkLine(
    'auto.components.editor.PackageJsonDependencyHoverMarkdown.029b0fdf8a',
    'Homepage',
    info.homepageUrl
  )
  if (homepageLine) {
    lines.push(homepageLine)
  }
  const repositoryLine = buildLinkLine(
    'auto.components.editor.PackageJsonDependencyHoverMarkdown.45cf3d1be0',
    'Repository',
    info.repositoryUrl
  )
  if (repositoryLine) {
    lines.push(repositoryLine)
  }
  return lines
}

function buildResultLines(
  result: NpmPackageInfoResult,
  installedVersion: InstalledPackageVersionResult
): string[] {
  switch (result.status) {
    case 'ok':
      return buildOkResultLines(result.info, installedVersion)
    case 'not-found':
      return [
        translate(
          'auto.components.editor.PackageJsonDependencyHoverMarkdown.45dba0fe67',
          'Package not found on the npm registry.'
        )
      ]
    case 'lookup-disabled':
      return [
        translate(
          'auto.components.editor.PackageJsonDependencyHoverMarkdown.5b15fa0805',
          'Package metadata lookups are disabled in Settings.'
        )
      ]
    case 'unavailable':
      return [
        translate(
          'auto.components.editor.PackageJsonDependencyHoverMarkdown.b9c4f13783',
          'Could not complete the lookup. Check your connection and try again.'
        )
      ]
  }
}

/**
 * Every registry-supplied string is markdown-escaped and every link is
 * protocol-allowlisted to `https:` before it reaches Monaco's non-trusted
 * `MarkdownString` — registry content is attacker-influencable.
 */
export function buildPackageJsonDependencyHoverMarkdown(params: {
  packageName: string
  installedVersion: InstalledPackageVersionResult
  result: NpmPackageInfoResult
}): string {
  const lines = [
    `**${escapeMarkdownText(params.packageName)}**`,
    '',
    buildInstalledLine(params.installedVersion),
    ...buildResultLines(params.result, params.installedVersion)
  ]
  return lines.join('\n')
}
