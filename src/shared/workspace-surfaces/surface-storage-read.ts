import type { SurfaceRunTarget, SurfaceAllocation } from './surface-allocation'
import type { WorkspaceSurface } from './surface-content'
import type { SurfaceHostDomain } from './surface-profile-domain'

/** Internal ordered storage reads return only the addressed record and its root stamp. */
export type SurfaceStorageRead =
  | { type: 'run'; hostId: string; target: SurfaceRunTarget }
  | { type: 'receipt'; hostId: string; callerId: string; commandId: string }
export type SurfaceStorageReadResult = {
  profileRevision: number
  rootRevision: number
  rootHash: string | null
} & (
  | { type: 'run'; surface: WorkspaceSurface | null; allocation: SurfaceAllocation | null }
  | { type: 'receipt'; receipt: SurfaceHostDomain['receipts'][number] | null }
)
