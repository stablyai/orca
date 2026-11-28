export const PACK_INDEX_MAINTENANCE_COOLDOWN_MS = 60 * 60_000
export const PACK_INDEX_MAINTENANCE_FAILURE_COOLDOWN_MS = 30 * 60_000

export type PackIndexMaintenanceOutcome =
  | 'written'
  | 'unchanged'
  | 'below_threshold'
  | 'opted_out'
  | 'protected'
  | 'deferred'
  | 'failed'
