import { describe, expect, it } from 'vitest'
import type {
  CloudEffectiveSecret,
  CloudSecretsCaller,
  CloudSecretsEffective
} from '../../../../../shared/cloud-secrets/cloud-secrets-wire'
import {
  cloudEnvRows,
  cloudKeyOwner,
  cloudKeyRows,
  withoutCallerPersonal
} from './cloud-panel-sections-model'
import { cloudPanelSectionsData } from './use-cloud-panel-sections'

const MEMBER: CloudSecretsCaller = {
  userId: 'u',
  orgId: 'o',
  orgRole: 'member',
  canWrite: { personal: true, org: false, repo: false }
}

function secret(patch: Partial<CloudEffectiveSecret> & { name: string }): CloudEffectiveSecret {
  return { kind: 'env', scope: 'org', hint: null, updatedAt: 0, shadowed: [], ...patch }
}

function effective(secrets: CloudEffectiveSecret[]): CloudSecretsEffective {
  return {
    caller: MEMBER,
    precedence: { env: ['repo', 'personal', 'org'], agent_key: ['org', 'repo', 'personal'] },
    secrets
  }
}

describe('cloudKeyOwner', () => {
  it('maps credential names to their agent', () => {
    expect(cloudKeyOwner('ANTHROPIC_AUTH_TOKEN')).toBe('claude')
    expect(cloudKeyOwner('OPENAI_BASE_URL')).toBe('codex')
    expect(cloudKeyOwner('GEMINI_API_KEY')).toBe('gemini')
    expect(cloudKeyOwner('AI_GATEWAY_API_KEY')).toBe('gateway')
    expect(cloudKeyOwner('AWS_REGION')).toBe('aws')
  })
})

describe('cloudKeyRows', () => {
  it('lists agent keys only, by agent, with the keys each one hides', () => {
    const rows = cloudKeyRows(
      effective([
        secret({ name: 'DATABASE_URL' }),
        secret({
          name: 'OPENAI_API_KEY',
          kind: 'agent_key',
          scope: 'org',
          hint: 'M3kz',
          shadowed: [{ scope: 'personal', hint: '9f2c' }]
        }),
        secret({ name: 'ANTHROPIC_API_KEY', kind: 'agent_key', scope: 'personal', hint: 'a1' })
      ])
    )
    expect(rows.map((row) => row.name)).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'])
    // A member can change their own Personal key, never the team's.
    expect(rows.map((row) => row.editable)).toEqual([true, false])
    expect(rows[1].shadowed).toEqual([{ scope: 'personal', hint: '9f2c', shadowedBy: 'org' }])
  })
})

describe('cloudEnvRows', () => {
  it('lists set variables with what they override, then missing names', () => {
    const rows = cloudEnvRows(
      effective([
        secret({
          name: 'DATABASE_URL',
          scope: 'repo',
          shadowed: [{ scope: 'personal', hint: null }]
        }),
        secret({ name: 'OPENAI_API_KEY', kind: 'agent_key' })
      ]),
      ['STRIPE_KEY']
    )
    expect(rows).toEqual([
      { kind: 'set', name: 'DATABASE_URL', scope: 'repo', overrides: ['personal'] },
      { kind: 'missing', name: 'STRIPE_KEY' }
    ])
  })
})

describe('shared workspaces (D13)', () => {
  const values = effective([
    secret({ name: 'NPM_TOKEN', scope: 'personal' }),
    secret({ name: 'SENTRY_DSN', scope: 'personal', shadowed: [{ scope: 'org', hint: null }] }),
    secret({ name: 'DATABASE_URL', scope: 'repo', shadowed: [{ scope: 'personal', hint: null }] })
  ])

  it("drops a teammate's Personal values: the next scope wins or the name goes missing", () => {
    expect(withoutCallerPersonal(values).secrets).toEqual([
      secret({ name: 'SENTRY_DSN', scope: 'org' }),
      secret({ name: 'DATABASE_URL', scope: 'repo' })
    ])
  })

  it('applies in every shared workspace, the owner’s too (SEC-5), and never in an unshared one', () => {
    const declared = ['NPM_TOKEN', 'SENTRY_DSN', 'DATABASE_URL']
    const base = { effective: values, envVarNames: declared, repoKey: null, asleep: false }
    expect(
      cloudPanelSectionsData({
        ...base,
        sharing: { shared: true, ownerName: 'Ada', isOwner: false }
      }).missing
    ).toEqual(['NPM_TOKEN'])
    const owner = cloudPanelSectionsData({
      ...base,
      sharing: { shared: true, ownerName: null, isOwner: true }
    })
    expect(owner.withoutPersonal).toBe(true)
    expect(owner.missing).toEqual(['NPM_TOKEN'])
    expect(
      cloudPanelSectionsData({
        ...base,
        sharing: { shared: false, ownerName: null, isOwner: true }
      }).missing
    ).toEqual([])
  })

  it('fails closed when the workspace sharing could not be read (D13)', () => {
    const declared = ['NPM_TOKEN', 'SENTRY_DSN', 'DATABASE_URL']
    const data = cloudPanelSectionsData({
      effective: values,
      envVarNames: declared,
      repoKey: null,
      asleep: false,
      sharing: null,
      sharingUnknown: true
    })
    expect(data.withoutPersonal).toBe(true)
    expect(data.missing).toEqual(['NPM_TOKEN'])
    expect(
      cloudPanelSectionsData({
        effective: values,
        envVarNames: declared,
        repoKey: null,
        asleep: false,
        sharing: null
      }).withoutPersonal
    ).toBe(false)
  })
})
