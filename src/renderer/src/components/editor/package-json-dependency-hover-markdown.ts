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

function buildInstalledText(installedVersion: InstalledPackageVersionResult): string {
  const label = translate(
    'auto.components.editor.PackageJsonDependencyHoverMarkdown.d3f501d912',
    'Installed'
  )
  const notInstalled = translate(
    'auto.components.editor.PackageJsonDependencyHoverMarkdown.5107bd60a9',
    'Not installed'
  )
  return installedVersion.status === 'installed'
    ? `${label}: ${escapeMarkdownText(installedVersion.version)}`
    : notInstalled
}

function buildLink(labelKey: string, fallback: string, url: string | null): string | null {
  const safeUrl = toSafeHttpsLink(url)
  if (!safeUrl) {
    return null
  }
  return `[${escapeMarkdownText(translate(labelKey, fallback))}](${safeUrl})`
}

/** Version facts describe one subject, so they share a line instead of reading
 * as a list of unrelated peers. */
function buildFactsBlock(
  result: NpmPackageInfoResult,
  installedVersion: InstalledPackageVersionResult
): string {
  const facts = [buildInstalledText(installedVersion)]
  if (result.status === 'ok' && result.info.latestVersion) {
    const latestLabel = translate(
      'auto.components.editor.PackageJsonDependencyHoverMarkdown.20c64d5223',
      'Latest'
    )
    const publishedAt = result.info.latestPublishedAt
      ? ` (${formatUiRelativeTimeFromDate(result.info.latestPublishedAt)})`
      : ''
    facts.push(`${latestLabel}: ${escapeMarkdownText(result.info.latestVersion)}${publishedAt}`)
    if (installedVersion.status === 'installed') {
      const severity = driftSeverityLabel(installedVersion.version, result.info.latestVersion)
      if (severity) {
        facts.push(severity)
      }
    }
  }
  return facts.join(' · ')
}

function buildLinksBlock(result: NpmPackageInfoResult): string | null {
  if (result.status !== 'ok') {
    return null
  }
  const links = [
    buildLink(
      'auto.components.editor.PackageJsonDependencyHoverMarkdown.029b0fdf8a',
      'Homepage',
      result.info.homepageUrl
    ),
    buildLink(
      'auto.components.editor.PackageJsonDependencyHoverMarkdown.45cf3d1be0',
      'Repository',
      result.info.repositoryUrl
    )
  ].filter((link): link is string => link !== null)
  return links.length > 0 ? links.join(' · ') : null
}

function buildDescriptionBlock(result: NpmPackageInfoResult): string | null {
  if (result.status !== 'ok' || !result.info.description) {
    return null
  }
  return escapeMarkdownText(result.info.description)
}

/**
 * Every registry-supplied string is markdown-escaped and every link is
 * protocol-allowlisted to `https:` before it reaches Monaco's non-trusted
 * `MarkdownString` — registry content is attacker-influencable.
 *
 * Blocks are separated by blank lines rather than rendered as a bullet list:
 * a name, a description, a set of version facts and a pair of links are not
 * peers, and bullets imply that they are.
 */
export function buildPackageJsonDependencyHoverMarkdown(params: {
  packageName: string
  installedVersion: InstalledPackageVersionResult
  result: NpmPackageInfoResult
}): string | null {
  // Why nothing rather than a failure message: a package on a private registry
  // is not missing, we simply never asked its host. Telling that user "not
  // found on the npm registry" on every internal dependency is worse than
  // showing no hover, which is what VS Code's npm extension does when a lookup
  // yields nothing.
  const hasRegistryInfo = params.result.status === 'ok'
  const hasInstalledVersion = params.installedVersion.status === 'installed'
  if (!hasRegistryInfo && !hasInstalledVersion) {
    return null
  }
  const blocks = [
    `**${escapeMarkdownText(params.packageName)}**`,
    buildDescriptionBlock(params.result),
    buildFactsBlock(params.result, params.installedVersion),
    buildLinksBlock(params.result)
  ].filter((block): block is string => block !== null && block.length > 0)
  return blocks.join('\n\n')
}
