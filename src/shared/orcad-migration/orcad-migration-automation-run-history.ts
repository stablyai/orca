/** Finished automation runs travel as one blob; the signed manifest carries only its digest, so run
 * history never bounds the manifest. Format changes require a new capability. */
import type { AutomationRun } from '../automations-types'
import type { OrcadMigrationBlobDescriptor } from './orcad-migration-blob-transfer'
import {
  serializeOrcadMigrationValue,
  type OrcadMigrationAutomationRunHistoryRef,
  type OrcadMigrationManifest
} from './orcad-migration-manifest'
import { parseOrcadMigrationCatalogPayload } from './orcad-migration-manifest-validation'
import { requiredRecord } from './orcad-migration-dormant-value-validation'

const ORCAD_MIGRATION_AUTOMATION_RUN_HISTORY_VERSION = 1

/** Canonical, so a re-export of an unchanged source reproduces the journaled digest. */
export function serializeOrcadMigrationAutomationRunHistory(
  runs: readonly AutomationRun[]
): string {
  return serializeOrcadMigrationValue({
    version: ORCAD_MIGRATION_AUTOMATION_RUN_HISTORY_VERSION,
    runs
  })
}

export function orcadMigrationAutomationRunHistoryBlob(
  ref: OrcadMigrationAutomationRunHistoryRef
): OrcadMigrationBlobDescriptor {
  return { blobKind: 'automation-run-history', key: 'migration', ...ref }
}

/** Blobs the manifest itself names; its commit is refused until they are staged. */
export function orcadMigrationManifestBlobs(
  manifest: Pick<OrcadMigrationManifest, 'payload'>
): OrcadMigrationBlobDescriptor[] {
  const ref = manifest.payload.dormantState?.automationRunHistory
  return ref ? [orcadMigrationAutomationRunHistoryBlob(ref)] : []
}

/** The manifest with its runs inline, validated against its own catalog as inline runs would be. */
export function withOrcadMigrationAutomationRunHistory<
  T extends Pick<OrcadMigrationManifest, 'payload'>
>(manifest: T, text: string): T {
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    throw new Error('orcad_migration_automation_run_history_invalid')
  }
  const record = requiredRecord(document, 'orcad_migration_automation_run_history_invalid')
  if (record.version !== ORCAD_MIGRATION_AUTOMATION_RUN_HISTORY_VERSION) {
    throw new Error('orcad_migration_automation_run_history_version_unsupported')
  }
  const { automationRunHistory: _ref, ...dormantState } = manifest.payload.dormantState ?? {}
  return {
    ...manifest,
    payload: parseOrcadMigrationCatalogPayload({
      ...manifest.payload,
      dormantState: { ...dormantState, automationRuns: record.runs }
    })
  }
}
