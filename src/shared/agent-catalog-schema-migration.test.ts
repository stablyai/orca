import { describe, expect, it } from 'vitest'
import {
  AGENT_CATALOG_SCHEMA_VERSION,
  migrateAgentCatalogSchema
} from './agent-catalog-schema-migration'

describe('migrateAgentCatalogSchema', () => {
  it('maps shipped legacy null (and missing) defaults to auto exactly once', () => {
    for (const legacyDefault of [null, undefined]) {
      const outcome = migrateAgentCatalogSchema({
        settings: legacyDefault === undefined ? {} : { defaultTuiAgent: legacyDefault },
        preV1RawContents: '{}',
        createBackup: () => ({ ok: true, created: true })
      })
      expect(outcome.didMigrate).toBe(true)
      expect(outcome.settingsPatch.defaultTuiAgent).toBe('auto')
      expect(outcome.settingsPatch.agentCatalogSchemaVersion).toBe(1)
      expect(outcome.settingsPatch.agentCatalogRevision).toBe(1)
      expect(outcome.settingsPatch.agentReferenceRevision).toBe(1)
    }
  })

  it('preserves explicit blank and concrete-id defaults', () => {
    for (const explicit of ['blank', 'codex'] as const) {
      const outcome = migrateAgentCatalogSchema({
        settings: { defaultTuiAgent: explicit },
        preV1RawContents: '{}',
        createBackup: () => ({ ok: true, created: true })
      })
      expect(outcome.didMigrate).toBe(true)
      expect('defaultTuiAgent' in outcome.settingsPatch).toBe(false)
    }
  })

  it('is idempotent: a second load with v1 stamped is a no-op', () => {
    const outcome = migrateAgentCatalogSchema({
      settings: {
        agentCatalogSchemaVersion: 1,
        agentCatalogRevision: 7,
        agentReferenceRevision: 3,
        defaultTuiAgent: null
      },
      preV1RawContents: '{}',
      createBackup: () => {
        throw new Error('backup must not run for a v1 profile')
      }
    })
    expect(outcome.didMigrate).toBe(false)
    expect(outcome.settingsPatch).toEqual({})
    // Post-v1 null stays null: repair-needed defaults never become Auto again.
  })

  it('performs no v1 write when backup creation fails and forces pre-v1 shape', () => {
    const outcome = migrateAgentCatalogSchema({
      settings: { defaultTuiAgent: null },
      preV1RawContents: '{"settings":{"defaultTuiAgent":null}}',
      createBackup: () => ({ ok: false, error: 'disk full' })
    })
    expect(outcome.didMigrate).toBe(false)
    expect(outcome.backupError).toBe('disk full')
    expect(outcome.settingsPatch.agentCatalogSchemaVersion).toBeUndefined()
    expect(outcome.settingsPatch.agentCatalogRevision).toBeUndefined()
    expect(outcome.settingsPatch.agentReferenceRevision).toBeUndefined()
    expect(outcome.settingsPatch.defaultTuiAgent).toBeNull()
    // The forced patch must explicitly carry the pre-v1 keys so fresh-install
    // defaults cannot leak through the settings spread.
    expect('agentCatalogSchemaVersion' in outcome.settingsPatch).toBe(true)
    expect('customTuiAgents' in outcome.settingsPatch).toBe(true)
    expect('deletedCustomTuiAgents' in outcome.settingsPatch).toBe(true)
  })

  it('skips the backup for a fresh install with no persisted file', () => {
    const outcome = migrateAgentCatalogSchema({
      settings: undefined,
      preV1RawContents: null,
      createBackup: () => {
        throw new Error('backup must not run for a fresh install')
      }
    })
    expect(outcome.didMigrate).toBe(true)
    expect(outcome.settingsPatch.defaultTuiAgent).toBe('auto')
    expect(outcome.settingsPatch.agentCatalogSchemaVersion).toBe(1)
  })

  it('normalizes hand-edited negative or non-integer revisions on v1 profiles', () => {
    const outcome = migrateAgentCatalogSchema({
      settings: {
        agentCatalogSchemaVersion: 1,
        agentCatalogRevision: -5 as number,
        agentReferenceRevision: 1.5 as number
      },
      preV1RawContents: '{}',
      createBackup: () => ({ ok: true, created: true })
    })
    expect(outcome.didMigrate).toBe(true)
    expect(outcome.settingsPatch.agentCatalogRevision).toBe(1)
    expect(outcome.settingsPatch.agentReferenceRevision).toBe(1)
  })
})

describe('corrupted schema-version stamp (L1-#8)', () => {
  it('repairs a malformed stamp without re-running the null->auto default remap', () => {
    for (const corruptedStamp of [1.5, 'one', Number.NaN, -1, true]) {
      const outcome = migrateAgentCatalogSchema({
        settings: {
          agentCatalogSchemaVersion: corruptedStamp as never,
          // A repair-generated null default written after v1 must stay null.
          defaultTuiAgent: null,
          agentCatalogRevision: 7,
          agentReferenceRevision: 3
        },
        preV1RawContents: '{}',
        createBackup: () => {
          throw new Error('a corrupted post-v1 stamp must not re-run the pre-v1 backup step')
        }
      })
      expect(outcome.settingsPatch.defaultTuiAgent).toBeUndefined()
      expect('defaultTuiAgent' in outcome.settingsPatch).toBe(false)
      expect(outcome.settingsPatch.agentCatalogSchemaVersion).toBe(1)
      expect(outcome.didMigrate).toBe(true)
      expect(outcome.backupError).toBeUndefined()
    }
  })

  it('still treats an explicit integer 0 stamp as pre-v1', () => {
    const outcome = migrateAgentCatalogSchema({
      settings: { agentCatalogSchemaVersion: 0, defaultTuiAgent: null },
      preV1RawContents: '{}',
      createBackup: () => ({ ok: true, created: true })
    })
    expect(outcome.settingsPatch.defaultTuiAgent).toBe('auto')
    expect(outcome.settingsPatch.agentCatalogSchemaVersion).toBe(1)
  })
})

describe('schema newer than this build', () => {
  it('refuses to write instead of normalizing a newer profile', () => {
    const outcome = migrateAgentCatalogSchema({
      settings: {
        agentCatalogSchemaVersion: AGENT_CATALOG_SCHEMA_VERSION + 1,
        defaultTuiAgent: null,
        agentCatalogRevision: 7
      },
      preV1RawContents: '{}',
      createBackup: () => {
        throw new Error('a newer profile must not re-run the pre-v1 backup step')
      }
    })
    expect(outcome.settingsPatch).toEqual({})
    expect(outcome.didMigrate).toBe(false)
    expect(outcome.schemaNewerThanSupported).toEqual({
      persistedVersion: AGENT_CATALOG_SCHEMA_VERSION + 1,
      supportedVersion: AGENT_CATALOG_SCHEMA_VERSION
    })
  })

  it('leaves the exactly-supported version writable', () => {
    const outcome = migrateAgentCatalogSchema({
      settings: {
        agentCatalogSchemaVersion: AGENT_CATALOG_SCHEMA_VERSION,
        agentCatalogRevision: 7,
        agentReferenceRevision: 3
      },
      preV1RawContents: '{}',
      createBackup: () => ({ ok: true, created: false })
    })
    expect(outcome.schemaNewerThanSupported).toBeUndefined()
    expect(outcome.didMigrate).toBe(false)
  })
})
