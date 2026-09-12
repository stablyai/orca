import { parseOrcadMigrationSourceCutover } from './orcad-migration-source-cutover'
import { serializeOrcadMigrationValue } from './orcad-migration-manifest'

export function validateOrcadLiveCutoverTransition(currentValue: unknown, nextValue: unknown) {
  const current = parseOrcadMigrationSourceCutover(currentValue)
  const next = parseOrcadMigrationSourceCutover(nextValue)
  const same = (a: unknown, b: unknown) =>
    serializeOrcadMigrationValue(a) === serializeOrcadMigrationValue(b)
  const authority = (record: typeof current) => ({
    version: record.version,
    destinationEnvironmentId: record.destinationEnvironmentId,
    destinationName: record.destinationName,
    manifest: record.manifest,
    startedAt: record.startedAt,
    liveTerminalBindings: record.liveTerminalBindings
  })
  const phases = ['source-fenced', 'destination-staged', 'destination-committed']
  if (
    current.version !== 2 ||
    next.version !== 2 ||
    !phases.includes(current.phase) ||
    !phases.includes(next.phase) ||
    !same(authority(current), authority(next)) ||
    phases.indexOf(next.phase) < phases.indexOf(current.phase) ||
    Date.parse(next.updatedAt) < Date.parse(current.updatedAt) ||
    (current.phase === 'destination-staged' &&
      next.phase === 'destination-staged' &&
      current.stagedAt !== next.stagedAt) ||
    (current.phase === 'destination-committed' &&
      (next.phase !== 'destination-committed' || !same(current.receipt, next.receipt)))
  ) {
    throw new Error('orcad_live_cutover_transition_conflict')
  }
  for (const publication of current.terminalPublications ?? []) {
    const retained = next.terminalPublications?.find(
      (entry) => entry.identity.bridgeId === publication.identity.bridgeId
    )
    if (!same(publication, retained)) {
      throw new Error('orcad_live_cutover_publication_evidence_changed')
    }
  }
  return next
}
