import { describe, expect, it } from 'vitest'
import type {
  CloudSecretsCaller,
  CloudSecretsEffective
} from '../../../../shared/cloud-secrets/cloud-secrets-wire'
import {
  askScopes,
  cloudSecretsAskData,
  environmentForRepo,
  githubRepoKey,
  missingSecretNames,
  applyDotenvPaste,
  parseScope,
  writableScopes
} from './cloud-secrets-ask-model'

const MEMBER: CloudSecretsCaller = {
  userId: 'u',
  orgId: 'o',
  orgRole: 'member',
  canWrite: { personal: true, org: false, repo: false }
}

function effective(names: string[]): CloudSecretsEffective {
  return {
    caller: MEMBER,
    precedence: { env: ['repo', 'personal', 'org'], agent_key: ['org', 'repo', 'personal'] },
    secrets: names.map((name) => ({
      name,
      kind: 'env',
      scope: 'org',
      hint: null,
      updatedAt: 0,
      shadowed: []
    }))
  }
}

describe('githubRepoKey', () => {
  it.each([
    ['https://github.com/Acme/Web.git', 'github.com/acme/web'],
    ['git@github.com:acme/web.git', 'github.com/acme/web'],
    ['ssh://git@github.com/acme/web', 'github.com/acme/web'],
    ['github.com/acme/web/', 'github.com/acme/web'],
    ['acme/web', 'github.com/acme/web']
  ])('reads %s', (url, key) => {
    expect(githubRepoKey(url)).toBe(key)
  })

  it('rejects other hosts', () => {
    expect(githubRepoKey('https://gitlab.com/acme/web')).toBeNull()
  })
})

describe('environmentForRepo', () => {
  it('finds the environment that lists the repo in any URL form', () => {
    const environments = [
      { id: 'a', repos: [{ url: 'https://github.com/acme/api', defaultBranch: null }] },
      { id: 'b', repos: [{ url: 'git@github.com:acme/web.git', defaultBranch: null }] }
    ]
    expect(environmentForRepo(environments, 'github.com/acme/web')?.id).toBe('b')
    expect(environmentForRepo(environments, 'github.com/acme/docs')).toBeNull()
  })
})

describe('missingSecretNames', () => {
  it('is declared names minus effective ones, without agent keys or repeats', () => {
    expect(
      missingSecretNames(
        ['DATABASE_URL', 'STRIPE_KEY', 'ANTHROPIC_API_KEY', 'STRIPE_KEY', 'SENTRY_DSN'],
        effective(['DATABASE_URL'])
      )
    ).toEqual(['STRIPE_KEY', 'SENTRY_DSN'])
  })
})

describe('writableScopes', () => {
  it('starts with Personal and adds only what the caller can write', () => {
    expect(writableScopes(MEMBER, { repo: true, shared: true })).toEqual(['personal'])
    const admin = { canWrite: { personal: true, org: true, repo: true } }
    expect(writableScopes(admin, { repo: true, shared: true })).toEqual(['personal', 'repo', 'org'])
    // A secret request never offers Shared, and Repository needs a repo.
    expect(writableScopes(admin, { repo: false, shared: false })).toEqual(['personal'])
  })

  it('leaves Personal out for a shared workspace (SEC-5)', () => {
    const repoWriter: CloudSecretsCaller = {
      ...MEMBER,
      canWrite: { personal: true, org: false, repo: true }
    }
    expect(askScopes({ caller: MEMBER, repoKey: 'github.com/a/b', shared: true })).toEqual([])
    expect(askScopes({ caller: repoWriter, repoKey: 'github.com/a/b', shared: true })).toEqual(['repo'])
    expect(askScopes({ caller: MEMBER, repoKey: 'github.com/a/b', shared: false })).toEqual(['personal'])
  })
})

describe('cloudSecretsAskData', () => {
  it('counts declared names without agent keys and flags a built environment', () => {
    const data = cloudSecretsAskData({
      environment: {
        name: 'acme-web',
        envVarNames: ['A', 'B', 'C', 'OPENAI_API_KEY'],
        activeBuildId: 'bld_1'
      },
      effective: effective(['A']),
      repoKey: 'github.com/acme/web'
    })
    expect(data).toMatchObject({ total: 3, missing: ['B', 'C'], built: true })
  })
})

describe('parseScope', () => {
  it('falls back to Personal for anything unexpected', () => {
    expect(parseScope('org')).toBe('org')
    expect(parseScope('team')).toBe('personal')
  })
})

describe('applyDotenvPaste', () => {
  it('fills only missing names and counts the rest as ignored', () => {
    const result = applyDotenvPaste(
      'STRIPE_KEY=sk_1\nOTHER=x\n# comment\nSENTRY_DSN="https://a"\nSTRIPE_KEY=sk_2',
      ['STRIPE_KEY', 'SENTRY_DSN', 'NPM_TOKEN'],
      { NPM_TOKEN: 'kept' }
    )
    expect(result.values).toEqual({
      NPM_TOKEN: 'kept',
      STRIPE_KEY: 'sk_2',
      SENTRY_DSN: 'https://a'
    })
    expect(result.summary).toEqual({ matched: 2, count: 3, ignored: 2 })
  })
})
