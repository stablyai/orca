import { describe, expect, it } from 'vitest'
import {
  buildErrorCopy,
  failedBuildSummary,
  normalizeRepoInput,
  repoDisplayName,
  stalenessBannerCopy
} from './cloud-environment-copy'
import type { EnvironmentStaleness } from './cloud-environment-types'
import { parseEnvVarNames } from './environment-draft'

const t = (_key: string, fallback: string, options?: Record<string, unknown>): string =>
  fallback.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options?.[name] ?? ''))

function staleness(overrides: Partial<EnvironmentStaleness>): EnvironmentStaleness {
  return {
    checkedAt: 0,
    activeBuildId: 'bld_1',
    configChanged: false,
    recommendation: 'up_to_date',
    repos: [
      {
        url: 'https://github.com/acme/web.git',
        branch: 'main',
        builtCommit: 'a',
        headCommit: 'b',
        aheadBy: 0,
        lockfilesChanged: [],
        error: null
      }
    ],
    ...overrides
  }
}

describe('stalenessBannerCopy', () => {
  it('names the repo and lockfile for dependency changes', () => {
    const copy = stalenessBannerCopy(
      staleness({
        recommendation: 'deps_changed',
        repos: [
          {
            url: 'https://github.com/acme/web.git',
            branch: 'main',
            builtCommit: 'a',
            headCommit: 'b',
            aheadBy: 3,
            lockfilesChanged: ['pnpm-lock.yaml'],
            error: null
          }
        ]
      }),
      6,
      t as never
    )
    expect(copy).toEqual({
      tone: 'prominent',
      rebuild: true,
      message: 'Dependencies changed in acme/web (pnpm-lock.yaml) since build #6'
    })
  })

  it('reports config changes', () => {
    expect(
      stalenessBannerCopy(staleness({ recommendation: 'config_changed' }), 6, t as never)?.message
    ).toBe('You changed the environment since build #6')
  })

  it('is subtle for a moved branch and pluralises through i18next count', () => {
    const many = stalenessBannerCopy(
      staleness({
        recommendation: 'branch_moved',
        repos: [{ ...staleness({}).repos[0], aheadBy: 12 }]
      }),
      6,
      t as never
    )
    expect(many).toEqual({
      tone: 'subtle',
      rebuild: false,
      message: 'main is 12 commits ahead of build #6'
    })
    const seen: Record<string, unknown>[] = []
    stalenessBannerCopy(
      staleness({
        recommendation: 'branch_moved',
        repos: [{ ...staleness({}).repos[0], aheadBy: 1 }]
      }),
      6,
      ((key: string, fallback: string, options?: Record<string, unknown>) => {
        seen.push(options ?? {})
        return t(key, fallback, options)
      }) as never
    )
    expect(seen[0]).toMatchObject({ count: 1 })
  })

  it('is subtle when Orca updated the base image', () => {
    const copy = stalenessBannerCopy(staleness({ recommendation: 'image_updated' }), 6, t as never)
    expect(copy).toEqual({
      tone: 'subtle',
      rebuild: true,
      message: 'Orca’s base image was updated since build #6 — rebuild to pick it up'
    })
    const flagged = stalenessBannerCopy(staleness({ imageUpdated: true }), 6, t as never)
    expect(flagged?.tone).toBe('subtle')
  })

  it('says nothing when up to date, unknown or never built', () => {
    expect(stalenessBannerCopy(staleness({}), 6, t as never)).toBeNull()
    expect(stalenessBannerCopy(staleness({ recommendation: 'unknown' }), 6, t as never)).toBeNull()
    expect(
      stalenessBannerCopy(staleness({ recommendation: 'deps_changed' }), null, t as never)
    ).toBeNull()
  })
})

describe('repo input', () => {
  it('normalizes owner/repo and GitHub URLs', () => {
    expect(normalizeRepoInput('acme/web')).toBe('acme/web')
    expect(normalizeRepoInput('https://github.com/acme/web.git')).toBe('acme/web')
    expect(normalizeRepoInput('https://github.com/acme/web/tree/main/src')).toBe('acme/web')
    expect(normalizeRepoInput('git@github.com:acme/web.git')).toBe('acme/web')
    expect(normalizeRepoInput('https://gitlab.com/acme/web')).toBeNull()
    expect(normalizeRepoInput('not a repo')).toBeNull()
    expect(repoDisplayName('https://github.com/acme/web.git')).toBe('acme/web')
  })
})

describe('env var names', () => {
  it('parses pasted lists and dotenv lines', () => {
    expect(parseEnvVarNames('FOO BAR,baz\nexport QUX=1\n1BAD')).toEqual({
      valid: ['FOO', 'BAR', 'BAZ', 'QUX'],
      invalid: ['1BAD']
    })
  })
})

describe('build failure copy', () => {
  it('never implies a failed build replaced the active one', () => {
    expect(failedBuildSummary(7, 'install', 6, t as never)).toEqual({
      headline: 'Build #7 failed at Run install script.',
      consequence: 'New workspaces still start from build #6.'
    })
    expect(failedBuildSummary(3, null, null, t as never)).toEqual({
      headline: 'Build #3 failed.',
      consequence: 'New workspaces start without a prebuilt environment until a build succeeds.'
    })
    expect(buildErrorCopy('exit_2', t as never)).toBe(
      'The install script stopped at a failing command.'
    )
    expect(buildErrorCopy('provider_503', t as never)).not.toMatch(/503|provider/)
    expect(buildErrorCopy(null, t as never)).toBeNull()
  })
})
