import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PLUGIN_SCHEMA_GIT_REF } from './plugin-json-schema'
import { satisfiesOrcaEngineRange } from './plugin-manifest'
import { PLUGIN_MANIFEST_V2_SINCE, PLUGIN_SCHEMA_SINCE_V1 } from './plugin-schema-field-docs'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..')

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true })
  } catch {
    return null
  }
}

/** Release versions, oldest first. Empty in shallow CI checkouts, which skip these checks. */
function releaseVersions(): string[] {
  return (git(['tag', '--list', 'v*']) ?? '')
    .split('\n')
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag))
    .map((tag) => tag.slice(1))
    .sort((a, b) => (a === b ? 0 : satisfiesOrcaEngineRange(a, `>=${b}`) ? 1 : -1))
}

function fileAt(version: string, file: string): string | null {
  return git(['show', `v${version}:${file}`])
}

function hasFileAt(version: string, file: string): boolean {
  return git(['cat-file', '-e', `v${version}:${file}`]) !== null
}

/** First version holding `file`, by binary search: once plugins shipped, the file stayed. */
function firstVersionWith(versions: readonly string[], file: string): string | undefined {
  let low = 0
  let high = versions.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    const version = versions[middle]
    if (version !== undefined && hasFileAt(version, file)) {
      high = middle
    } else {
      low = middle + 1
    }
  }
  return versions[low]
}

describe('schema since-versions', () => {
  it('names the first release that read plugins as the v1 baseline', () => {
    const versions = releaseVersions()
    if (versions.length === 0) {
      return
    }
    const first = firstVersionWith(versions, 'src/shared/plugins/plugin-manifest.ts')
    expect(first).toBe(PLUGIN_SCHEMA_SINCE_V1)
  })

  // Why: authors gate on this version, so it must name a release that really reads manifest v2.
  it('names the first release tag that ships manifest v2', () => {
    const first = releaseVersions().find((version) =>
      satisfiesOrcaEngineRange(version, `>=${PLUGIN_MANIFEST_V2_SINCE}`)
    )
    if (!first) {
      return
    }
    const manifest = fileAt(first, 'src/shared/plugins/plugin-manifest.ts') ?? ''
    expect(
      manifest.includes('z.literal(2)'),
      `v${first} ships without manifest v2: bump PLUGIN_MANIFEST_V2_SINCE to the release that does`
    ).toBe(true)
    expect(
      PLUGIN_SCHEMA_GIT_REF,
      `v${first} shipped: point PLUGIN_SCHEMA_GIT_REF at its tag and regenerate`
    ).toBe(`v${PLUGIN_MANIFEST_V2_SINCE}`)
  })
})
