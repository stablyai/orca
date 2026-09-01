import { describe, expect, it } from 'vitest'
import {
  agentCatalogSchemaTooNewMessage,
  agentCatalogSchemaTooNewVersions,
  asAgentCatalogSchemaTooNew
} from './agent-catalog-schema-too-new'

describe('asAgentCatalogSchemaTooNew', () => {
  it('narrows the read-only rejection with its versions', () => {
    expect(
      asAgentCatalogSchemaTooNew({
        ok: false,
        code: 'agent_catalog_schema_too_new',
        persistedVersion: 2,
        supportedVersion: 1
      })
    ).toEqual({
      ok: false,
      code: 'agent_catalog_schema_too_new',
      persistedVersion: 2,
      supportedVersion: 1
    })
  })

  it('ignores successes and other rejections', () => {
    expect(asAgentCatalogSchemaTooNew({ ok: true })).toBeNull()
    expect(
      asAgentCatalogSchemaTooNew({ ok: false, code: 'agent_catalog_migration_blocked' })
    ).toBeNull()
    expect(asAgentCatalogSchemaTooNew({ ok: false })).toBeNull()
  })

  it('tolerates a host that omitted the versions', () => {
    expect(
      asAgentCatalogSchemaTooNew({ ok: false, code: 'agent_catalog_schema_too_new' })
    ).toMatchObject({ persistedVersion: 0, supportedVersion: 0 })
  })
})

describe('schema-too-new copy', () => {
  it('says the profile is from a newer Orca and that retrying will not help', () => {
    const message = agentCatalogSchemaTooNewMessage().toLowerCase()
    expect(message).toContain('newer version of orca')
    expect(message).toContain('retrying will not help')
  })

  it('omits the version line when the host reported no usable versions', () => {
    expect(agentCatalogSchemaTooNewVersions({ persistedVersion: 0, supportedVersion: 0 })).toBe('')
    expect(
      agentCatalogSchemaTooNewVersions({ persistedVersion: 2, supportedVersion: 1 })
    ).toContain('v2')
  })
})
