import { describe, expect, it } from 'vitest'
import type { OrcadMigrationManifest } from './orcad-migration-manifest'
import { parseOrcadMigrationCatalogReferenceAbortResult } from './orcad-migration-catalog-state'

const identity = { migrationId: 'move-1', manifestSha256: 'a'.repeat(64) }
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the parser reads only the identity fields.
const manifest = identity as OrcadMigrationManifest

describe('parseOrcadMigrationCatalogReferenceAbortResult', () => {
  it('keeps a host’s proof that its committed answer was flushed', () => {
    expect(
      parseOrcadMigrationCatalogReferenceAbortResult(
        { ...identity, state: 'committed', aborted: false, durableCommitted: true },
        manifest
      )
    ).toEqual({ ...identity, state: 'committed', aborted: false, durableCommitted: true })
  })

  it('reads an older host’s committed answer as not proven durable', () => {
    expect(
      parseOrcadMigrationCatalogReferenceAbortResult(
        { ...identity, state: 'committed', aborted: false, durableCommitted: 'yes' },
        manifest
      )
    ).toEqual({ ...identity, state: 'committed', aborted: false })
  })
})
