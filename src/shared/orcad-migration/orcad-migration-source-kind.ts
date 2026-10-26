/** Legacy SSH omits source.kind to preserve signed bytes/digests. Other kinds must set kind and omit sshTargetId:
 * older destinations strip unknown fields, then fail parsing instead of importing a non-SSH source as SSH. */
import type {
  OrcadMigrationLocalWslManifestSource,
  OrcadMigrationManifestSource,
  OrcadMigrationSshManifestSource
} from './orcad-migration-manifest'
import { ORCAD_MIGRATION_LOCAL_WSL_SOURCE_RUNTIME_CAPABILITY } from '../orcad-runtime-capabilities'

export const ORCAD_MIGRATION_SSH_RELAY_SOURCE_KIND = 'ssh-relay' as const

/** Non-SSH kinds and the destination capability that proves a destination parses each one. */
export const ORCAD_MIGRATION_SOURCE_KIND_CAPABILITIES = {
  'local-wsl': ORCAD_MIGRATION_LOCAL_WSL_SOURCE_RUNTIME_CAPABILITY
} as const

export type OrcadMigrationNonSshSourceKind = keyof typeof ORCAD_MIGRATION_SOURCE_KIND_CAPABILITIES
export type OrcadMigrationSourceKind =
  | typeof ORCAD_MIGRATION_SSH_RELAY_SOURCE_KIND
  | OrcadMigrationNonSshSourceKind

export const ORCAD_MIGRATION_SOURCE_KIND_UNKNOWN = 'orcad_migration_source_kind_unknown'

/** A manifest source as it travels: this build may not know every field a newer peer signed. */
export type OrcadMigrationWireSource = Readonly<Record<string, unknown>>

export function orcadMigrationManifestSourceKind(
  source: OrcadMigrationWireSource
): OrcadMigrationSourceKind {
  if (source.kind === undefined) {
    return ORCAD_MIGRATION_SSH_RELAY_SOURCE_KIND
  }
  // An explicit 'ssh-relay' is refused too: SSH has exactly one encoding, so one digest.
  if (isNonSshSourceKind(source.kind)) {
    return source.kind
  }
  throw new Error(ORCAD_MIGRATION_SOURCE_KIND_UNKNOWN)
}

function isNonSshSourceKind(kind: unknown): kind is OrcadMigrationNonSshSourceKind {
  return typeof kind === 'string' && Object.hasOwn(ORCAD_MIGRATION_SOURCE_KIND_CAPABILITIES, kind)
}

/** The capability a destination must advertise before it may see this source; null for SSH. */
export function requiredOrcadMigrationSourceCapability(
  source: OrcadMigrationWireSource
): string | null {
  const kind = orcadMigrationManifestSourceKind(source)
  return kind === ORCAD_MIGRATION_SSH_RELAY_SOURCE_KIND
    ? null
    : ORCAD_MIGRATION_SOURCE_KIND_CAPABILITIES[kind]
}

export function isOrcadMigrationLocalWslSource(
  source: OrcadMigrationManifestSource
): source is OrcadMigrationLocalWslManifestSource {
  return 'kind' in source && source.kind === 'local-wsl'
}

/** For the SSH conversion's own steps: a WSL manifest reaching them is a bug, never a fallback. */
export function requireOrcadMigrationSshSource(
  source: OrcadMigrationManifestSource
): OrcadMigrationSshManifestSource {
  if (isOrcadMigrationLocalWslSource(source)) {
    throw new Error('orcad_migration_source_not_ssh')
  }
  return source
}
