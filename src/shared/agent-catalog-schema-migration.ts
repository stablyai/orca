// One-time agent-catalog v1 schema migration: maps the shipped legacy
// `defaultTuiAgent: null` (which meant Auto) to the explicit persisted 'auto'
// and stamps `agentCatalogSchemaVersion: 1`. Before the first v1 write of an
// existing profile, a pinned same-permission pre-v1 backup is created beside
// the rotating backups; if that backup cannot be created, no v1 write happens
// and launch behavior stays on the clean built-in baseline.
//
// Why shared: the CLI's offline settings writes need AGENT_CATALOG_SCHEMA_VERSION
// for their schema-newer-than-this-CLI guard, and out/main does not survive
// electron-vite rebuilds. The fs-bound backup writer this migration injects
// lives in src/main/agent-launch/agent-catalog-pre-v1-backup.ts.

import type { GlobalSettings } from './types'

export const AGENT_CATALOG_SCHEMA_VERSION = 1

export type PinnedBackupResult = { ok: true; created: boolean } | { ok: false; error: string }

export type AgentCatalogSchemaMigrationOutcome = {
  /** Patch merged into loaded settings; empty object when nothing changed. */
  settingsPatch: Partial<GlobalSettings>
  didMigrate: boolean
  /** Present when the pinned backup failed; the profile stays pre-v1 and Settings
   *  must surface a local migration error. */
  backupError?: string
  /** Present when the persisted stamp is newer than this build understands. The
   *  profile is read-only: callers must block every catalog/reference write
   *  rather than rewrite fields whose newer meaning they cannot represent. */
  schemaNewerThanSupported?: { persistedVersion: number; supportedVersion: number }
}

function normalizeRevision(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback
}

/** Compute the one-time v1 migration for loaded settings. Pure except for the
 *  injected backup step; a second load with v1 already stamped is a no-op. */
export function migrateAgentCatalogSchema(args: {
  settings: Partial<GlobalSettings> | undefined
  /** Null for a fresh install with no persisted file (no pre-v1 state to pin). */
  preV1RawContents: string | null
  createBackup: () => PinnedBackupResult
}): AgentCatalogSchemaMigrationOutcome {
  const settings = args.settings
  // Loaded settings come from parsed JSON, so the stamp may hold any shape.
  const rawVersion: unknown = settings?.agentCatalogSchemaVersion
  // A present-but-malformed stamp can only follow a v1 write (hand-edit or
  // corruption). Treating it as pre-v1 would re-run the one-time null->auto
  // default remap and overwrite a repair-generated null, so repair the stamp
  // instead of re-migrating.
  const stampCorrupted =
    rawVersion !== undefined &&
    rawVersion !== null &&
    !(typeof rawVersion === 'number' && Number.isInteger(rawVersion) && rawVersion >= 0)
  const currentVersion = stampCorrupted
    ? AGENT_CATALOG_SCHEMA_VERSION
    : normalizeRevision(rawVersion, 0)
  // A newer stamp can only come from a newer build (or a synced profile). Even
  // the revision normalization below would be a write, so refuse outright.
  if (currentVersion > AGENT_CATALOG_SCHEMA_VERSION) {
    return {
      settingsPatch: {},
      didMigrate: false,
      schemaNewerThanSupported: {
        persistedVersion: currentVersion,
        supportedVersion: AGENT_CATALOG_SCHEMA_VERSION
      }
    }
  }
  if (currentVersion >= AGENT_CATALOG_SCHEMA_VERSION) {
    // Revisions must remain monotonic non-negative integers even if hand-edited.
    const catalogRevision = normalizeRevision(settings?.agentCatalogRevision, 1)
    const referenceRevision = normalizeRevision(settings?.agentReferenceRevision, 1)
    const patch: Partial<GlobalSettings> = {}
    let didMigrate = false
    if (stampCorrupted) {
      patch.agentCatalogSchemaVersion = AGENT_CATALOG_SCHEMA_VERSION
      didMigrate = true
    }
    if (settings?.agentCatalogRevision !== catalogRevision) {
      patch.agentCatalogRevision = catalogRevision
      didMigrate = true
    }
    if (settings?.agentReferenceRevision !== referenceRevision) {
      patch.agentReferenceRevision = referenceRevision
      didMigrate = true
    }
    return { settingsPatch: patch, didMigrate }
  }

  if (args.preV1RawContents !== null) {
    const backup = args.createBackup()
    if (!backup.ok) {
      // No v1 write of any kind: force the merged settings back to the exact
      // pre-v1 shape so the fresh-install defaults (schema version, 'auto',
      // empty catalog arrays) cannot leak through the defaults spread.
      return {
        settingsPatch: {
          agentCatalogSchemaVersion: undefined,
          agentCatalogRevision: undefined,
          agentReferenceRevision: undefined,
          customTuiAgents: settings?.customTuiAgents,
          deletedCustomTuiAgents: settings?.deletedCustomTuiAgents,
          defaultTuiAgent: settings?.defaultTuiAgent ?? null
        },
        didMigrate: false,
        backupError: backup.error
      }
    }
  }

  const patch: Partial<GlobalSettings> = {
    agentCatalogSchemaVersion: AGENT_CATALOG_SCHEMA_VERSION,
    agentCatalogRevision: 1,
    agentReferenceRevision: 1
  }
  // Shipped legacy null meant Auto. This mapping runs exactly once, before any
  // repair can produce a new null; later repair-generated null stays null.
  const rawDefault = settings?.defaultTuiAgent
  if (rawDefault === null || rawDefault === undefined) {
    patch.defaultTuiAgent = 'auto'
  }
  return { settingsPatch: patch, didMigrate: true }
}
