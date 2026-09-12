import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { serializeOrcadMigrationValue } from '../../../src/shared/orcad-migration-manifest'

function changedPaths(expected: unknown, actual: unknown, path: string): string[] {
  if (serializeOrcadMigrationValue(expected) === serializeOrcadMigrationValue(actual)) {
    return []
  }
  if (
    !expected ||
    !actual ||
    typeof expected !== 'object' ||
    typeof actual !== 'object' ||
    Array.isArray(expected) ||
    Array.isArray(actual)
  ) {
    return [path]
  }
  const left = expected as Record<string, unknown>
  const right = actual as Record<string, unknown>
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].flatMap((key) =>
    changedPaths(left[key], right[key], `${path}.${key}`)
  )
}

/** Only disposable fixture profiles; report structure, never persisted values. */
export async function inspectRetirementProfileDrift(
  userData: string,
  observedSessions: Record<string, unknown>
) {
  if (
    !['orca-e2e-userdata-', 'orca-e2e-restart-'].some((prefix) =>
      basename(userData).startsWith(prefix)
    )
  ) {
    throw new Error('fixture_disposable_profile_required')
  }
  const profile = join(userData, 'profiles', 'local-default')
  const state = JSON.parse(await readFile(join(profile, 'orca-data.json'), 'utf8'))
  const directory = join(userData, 'orcad-live-source-retirement-records')
  const names = await readdir(directory)
  return Promise.all(
    names
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .map(async (name) => {
        const record = JSON.parse(await readFile(join(directory, name), 'utf8'))
        const migrationId = record.release.cutover.manifest.migrationId
        const journal = state.orcadMigrationSourceCutovers?.find(
          (entry: { manifest: { migrationId: string } }) =>
            entry.manifest.migrationId === migrationId
        )
        const marker = state.orcadLiveRetirementMarkers?.find(
          (entry: { migrationId: string }) => entry.migrationId === migrationId
        )
        const fields = record.changes.map(
          (change: { field: string; before: string | null; after: string | null }) => {
            const current =
              state[change.field] === undefined
                ? null
                : serializeOrcadMigrationValue(state[change.field])
            return {
              field: change.field,
              matchesBefore: current === change.before,
              matchesAfter: current === change.after,
              changedPaths: changedPaths(
                change.after === null ? undefined : JSON.parse(change.after),
                state[change.field],
                change.field
              ),
              observedSessionChangedPaths:
                change.field === 'workspaceSessionsByHostId' && change.after !== null
                  ? Object.entries(observedSessions).flatMap(([hostId, session]) =>
                      changedPaths(
                        JSON.parse(change.after!)[hostId],
                        session,
                        `${change.field}.${hostId}`
                      )
                    )
                  : undefined
            }
          }
        )
        return {
          fields,
          journalChangedPaths: changedPaths(record.release.cutover, journal, 'journal'),
          markerPresent: marker !== undefined,
          markerMatchesRecord: marker?.recordSha256 === record.sha256
        }
      })
  )
}
